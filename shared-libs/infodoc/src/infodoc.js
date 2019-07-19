const db = {}; // to be filled in by the initLib function exported below

const getInfoDocId = id => id + '-info';
const getDocId = infoDocId => infoDocId.slice(0, -5);
const blankInfoDoc = (docId, knownReplicatationDate) => {
  return {
    _id: getInfoDocId(docId),
    type: 'info',
    doc_id: docId,
    initial_replication_date: knownReplicatationDate || 'unknown',
    latest_replication_date: knownReplicatationDate || 'unknown',
    transitions: {}
  };
};

const findInfoDocs = (database, changes) => {
  return database
    .allDocs({ keys: changes.map(change => getInfoDocId(change.id)), include_docs: true })
    .then(results => results.rows);
};

const getInfoDoc = change => {
  const infoDocId = getInfoDocId(change.id);
  return db.sentinel.get(infoDocId)
    .catch(err => {
      if (err.status !== 404) {
        throw err;
      }

      return db.medic.get(infoDocId)
        .catch(err => {
          if (err.status !== 404) {
            throw err;
          }

          return blankInfoDoc(change.id);
        })
        .then(infoDoc => {
          if (infoDoc._rev) {
            // Delete intentionally out of control flow for performance
            db.medic.remove(infoDocId, infoDoc._rev);
            delete infoDoc._rev;
          }

          return db.sentinel.put(infoDoc)
            .then(result => {
              infoDoc._rev = result.rev;
              return infoDoc;
            })
            .catch(err => {
              if (err.status !== 409) {
                throw err;
              }

              // conflict, try the whole thing again from the top
              return getInfoDoc(change);
            });
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

const bulkGet = changes => {
  const infoDocs = [];

  if (!changes || !changes.length) {
    return Promise.resolve();
  }

  return findInfoDocs(db.sentinel, changes)
    .then(result => {
      const missing = [];
      result.forEach(row => {
        if (!row.doc) {
          missing.push({ id: getDocId(row.key) });
        } else {
          infoDocs.push(row.doc);
        }
      });

      if (!missing.length) {
        return [];
      }

      return findInfoDocs(db.medic, missing);
    })
    .then(result => {
      result.forEach(row => {
        if (!row.doc) {
          infoDocs.push(blankInfoDoc(getDocId(row.key)));
        } else {
          row.doc.legacy = true;
          infoDocs.push(row.doc);
        }
      });

      return infoDocs;
    });
};

const bulkUpdate = infoDocs => {
  const legacyDocs = [];

  if (!infoDocs || !infoDocs.length) {
    return Promise.resolve();
  }

  infoDocs.forEach(doc => {
    if (doc.legacy) {
      delete doc.legacy;
      legacyDocs.push(Object.assign({ _deleted: true }, doc));
      delete doc._rev;
    }
  });

  return db.sentinel.bulkDocs(infoDocs).then(results => {
    if (legacyDocs.length) {
      // Delete intentionally out of control flow for performance
      db.medic.bulkDocs(legacyDocs);
    }

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
        });

        return bulkUpdate(freshInfoDocs);
      });
    }
  });
};

const maintainOneMetadata = id => {
  return db.sentinel.get(getInfoDocId(id))
    .catch(err => {
      if (err.status !== 404) {
        throw err;
      }

      return blankInfoDoc(id, new Date());
    })
    .then(infoDoc => {
      infoDoc.latest_replication_date = new Date();
      return db.sentinel.put(infoDoc)
        .catch(err => {
          if (err.status === 409) {
            return maintainOneMetadata(id);
          }

          throw err;
        });
    });
};

const maintainManyMetadata = ids => {
  const infoDocIds = ids.map(getInfoDocId);

  return db.sentinel.allDocs({
    keys: infoDocIds,
    include_docs: true
  }).then(results => {
    const updatedInfoDocs = results.rows.map(row => {
      const infoDoc = row.doc || blankInfoDoc(getDocId(row.key), new Date());

      infoDoc.latest_replication_date = new Date();

      return infoDoc;
    });

    return db.sentinel.bulkDocs(updatedInfoDocs)
      .then(bulkResults => {
        const conflictingIds = bulkResults
          .filter(r => r.error === 'conflict')
          .map(r => getDocId(r.id));

        if (conflictingIds.length > 0) {
          return maintainManyMetadata(conflictingIds);
        }
      });
  });
};

module.exports = {
  initLib: (medicDb, sentinelDb) => {
    db.medic = medicDb;
    db.sentinel = sentinelDb;
  },
  get: change => getInfoDoc(change),
  delete: change => deleteInfoDoc(change),
  updateTransition: (change, transition, ok) =>
    updateTransition(change, transition, ok),
  bulkGet: bulkGet,
  bulkUpdate: bulkUpdate,
  saveTransitions: saveTransitions,
  recordDocumentWrite: maintainOneMetadata,
  recordDocumentWrites: maintainManyMetadata
};
