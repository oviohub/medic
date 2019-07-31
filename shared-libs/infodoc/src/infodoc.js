const db = {}; // to be filled in by the initLib function exported below

const getInfoDocId = id => id + '-info';
const getDocId = infoDocId => infoDocId.slice(0, -5);
const blankInfoDoc = (docId, knownReplicatationDate) => {
  return {
    _id: getInfoDocId(docId),
    type: 'info',
    doc_id: docId,
    initial_replication_date: knownReplicatationDate || 'unknown',
    latest_replication_date: knownReplicatationDate || 'unknown'
  };
};

const findInfoDocs = (database, ids) => {
  if (ids.length === 1) {
    const id = ids[0];
    return database.get(id)
      .then(doc => {
        return [{
          key: doc._id,
          doc: doc
        }];
      })
      .catch(err => {
        if (err.status !== 404) {
          throw err;
        }

        return [{
          key: id,
          error: 'not_found'
        }];
      });
  } else {
    return database
      .allDocs({ keys: ids, include_docs: true })
      .then(results => results.rows);
  }
};

//
// Given a set of changes, find all the infoDocs or create them as necessary. Also takes care of
// migrating legacy infodocs from the medic db, and legacy transition information from records.
//
// @param      {Array}  changes  an array of PouchDB changes objects
// @return     {Array}  array of infodocs. NB: will not necessarily be in the same order as the
//                      changes were passed in
//
const resolveInfoDocs = changes => {
  const splitInfoDocRows = results => {
    return results.reduce((acc, row) => {
      if (!row.doc) {
        acc.missing.push({_id: row.key});
      } else if (!row.doc.transitions) {
        // No transitions may mean that API created this infodoc on write but sentinel hasn't seen
        // it yet. It's possible that there is a legacy infodoc with transition information.
        acc.missingTransitions.push(row.doc);
      } else {
        acc.valid.push(row.doc);
      }

      return acc;

    }, {valid: [], missing: [], missingTransitions: []});
  };

  if (!changes || !changes.length) {
    return Promise.resolve();
  }

  const infoDocIds = changes.map(change => getInfoDocId(change.id));

  // First attempt, directly from sentinel where they should live
  return findInfoDocs(db.sentinel, infoDocIds)
    .then(results => {
      const { valid, missing, missingTransitions: missingTransitionsSentinel } = splitInfoDocRows(results);

      const lookForInMedic = missing.concat(missingTransitionsSentinel).map(r => r._id);

      if (!lookForInMedic.length) {
        return valid;
      }

      // the infodocs missing transitions are still valid. We distinguish between them so we can
      // check for medic-db infodocs and if they exist transfer the transition data over
      const infoDocs = valid.concat(missingTransitionsSentinel);

      // Second attempt, look for old infodocs in the Medic DB.
      return findInfoDocs(db.medic, lookForInMedic)
        .then(results => {
          const migratedInfoDocs = [];
          const { valid, missing, missingTransitions: missingTransitionsMedic } = splitInfoDocRows(results);

          // There is no interesting reason for a legacy medic infodoc to not have transitions, it's valid enough!
          valid.push(...missingTransitionsMedic);

          // Convert valid MedicDB infodocs into Sentinel ones
          valid.forEach(medicInfoDoc => {
            const sentinelInfoDoc = missingTransitionsSentinel.find(d => d._id === medicInfoDoc._id);
            if (sentinelInfoDoc) {
              // Augment the sentinel info doc with the existing transition information
              sentinelInfoDoc.transitions = medicInfoDoc.transitions;
              migratedInfoDocs.push(sentinelInfoDoc);
            } else {
              const infoDoc = Object.assign({}, medicInfoDoc);
              delete infoDoc._rev;
              infoDocs.push(infoDoc);
              migratedInfoDocs.push(infoDoc);
            }

            medicInfoDoc._deleted = true;
          });

          // Intentionally not waiting on the promise for performance
          db.medic.bulkDocs(valid);

          // Infodocs that aren't in the Medic DB. This could mean there isn't one at all, or it
          // could be that there was one without transition data back in sentinel
          missing.forEach(row => {
            const docId = getDocId(row._id);

            const collectedInfoDoc = infoDocs.find(i => i._id === row._id);
            const infoDoc = collectedInfoDoc || blankInfoDoc(docId);
            const change = changes.find(change => change.id === docId);

            infoDoc.transitions = (change.doc && change.doc.transitions) || {};

            if (!collectedInfoDoc) {
              infoDocs.push(infoDoc);
            }

            migratedInfoDocs.push(infoDoc);
          });

          // After all checks if there are still infodocs without transition information add a stub
          infoDocs.forEach(infoDoc => {
            if (!infoDoc.transitions) {
              infoDoc.transitions = {};
            }
          });

          // Store any infoDocs that have been migrated.
          if (migratedInfoDocs.length) {
            return db.sentinel.bulkDocs(migratedInfoDocs)
              .then(results => {
                results.forEach((r, idx) => {
                  if (!r.ok) {
                    throw new Error(`Failed to update a modified infodoc: ${JSON.stringify(r)}`);
                  }

                  // Anything in this is also in infoDocs, so it's modifying what we return to the caller
                  migratedInfoDocs[idx]._rev = r.rev;
                });

                return infoDocs;
              });
          } else {
            return infoDocs;
          }
        });
    });
};

const deleteInfoDoc = change => {
  return db.sentinel
    .get(getInfoDocId(change.id))
    .then(doc => {
      doc._deleted = true;
      return db.sentinel.put(doc);
    })
    .catch(err => {
      if (err.status !== 404) {
        throw err;
      }
    });
};

const updateTransition = (change, transition, ok) => {
  const info = change.info;
  info.transitions = info.transitions || {};
  info.transitions[transition] = {
    last_rev: change.doc._rev,
    seq: change.seq,
    ok: ok,
  };
};

const saveTransitions = change => {
  return db.sentinel.get(getInfoDocId(change.id))
    .catch(err => {
      if (err.status !== 404) {
        throw err;
      }

      return change.info;
    })
    .then(doc => {
      doc.transitions = change.info.transitions || {};
      return db.sentinel.put(doc);
    })
    .catch(err => {
      if (err.status !== 409) {
        throw err;
      }

      return saveTransitions(change);
    });
};

const bulkUpdate = infoDocs => {
  if (!infoDocs || !infoDocs.length) {
    return Promise.resolve();
  }

  return db.sentinel.bulkDocs(infoDocs).then(results => {
    const conflictingInfoDocs = infoDocs
      .filter((_, idx) => results[idx].error === 'conflict');

    if (conflictingInfoDocs.length > 0) {
      // Attempt an intelligent merge based on responsibilities For right now this is only the
      // transitions block. If the caller of this code (sentinel) needs to maintain other
      // information in the infodoc or others call this code we would need to be smarter about how
      // we merge.
      return db.sentinel.allDocs({
        keys: conflictingInfoDocs.map(d => d._id),
        include_docs: true
      }).then(results => {
        const freshInfoDocs = results.rows.map(r => r.doc);

        freshInfoDocs.forEach((freshInfoDoc, idx) => {
          // We aren't attempting to merge this: as of writing transitions do not run in parallel,
          // and so there should be no way that the conflicted version of the document has any new
          // information to add.
          freshInfoDoc.transitions = conflictingInfoDocs[idx].transitions;
          freshInfoDoc.muting_history = conflictingInfoDocs[idx].muting_history;
        });

        return bulkUpdate(freshInfoDocs);
      });
    }
  });
};

const recordDocumentWrite = (id, date) => {
  return db.sentinel.get(getInfoDocId(id))
    .catch(err => {
      if (err.status !== 404) {
        throw err;
      }

      return blankInfoDoc(id, date);
    })
    .then(infoDoc => {
      infoDoc.latest_replication_date = date;
      return db.sentinel.put(infoDoc)
        .catch(err => {
          if (err.status === 409) {
            return recordDocumentWrite(id, date);
          }

          throw err;
        });
    });
};

const recordDocumentWrites = (ids, date) => {
  const infoDocIds = ids.map(getInfoDocId);

  return db.sentinel.allDocs({
    keys: infoDocIds,
    include_docs: true
  }).then(results => {
    const updatedInfoDocs = results.rows.map(row => {
      const infoDoc = row.doc || blankInfoDoc(getDocId(row.key), date);

      infoDoc.latest_replication_date = date;

      return infoDoc;
    });

    return db.sentinel.bulkDocs(updatedInfoDocs)
      .then(bulkResults => {
        const conflictingIds = bulkResults
          .filter(r => r.error === 'conflict')
          .map(r => getDocId(r.id));

        if (conflictingIds.length > 0) {
          return recordDocumentWrites(conflictingIds, date);
        }
      });
  });
};

module.exports = {
  initLib: (medicDb, sentinelDb) => {
    db.medic = medicDb;
    db.sentinel = sentinelDb;
  },
  get: change => resolveInfoDocs([change]).then(([firstResult]) => firstResult),
  delete: change => deleteInfoDoc(change),
  updateTransition: (change, transition, ok) =>
    updateTransition(change, transition, ok),
  bulkGet: resolveInfoDocs,
  bulkUpdate: bulkUpdate,
  saveTransitions: saveTransitions,

  // Used to update infodoc metadata that occurs at write time. A delete does not count as a write
  // in this instance, as deletes resolve as infodoc cleanups once sentinel gets to processing the
  // delete
  recordDocumentWrite: id => recordDocumentWrite(id, new Date()),
  recordDocumentWrites: ids => recordDocumentWrites(ids, new Date())
};
