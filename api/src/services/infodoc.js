const db = require('../db');

const getInfoDocId = id => id + '-info';
const getDataDocId = id => id.substring(0, id.length - 5);

const newInfoDoc = id => ({
  _id: getInfoDocId(id),
  type: 'info',
  doc_id: id
});

const updateOne = id => {
  return db.sentinel.get(getInfoDocId(id))
    .catch(err => {
      if (err.status !== 404) {
        throw err;
      }

      return newInfoDoc(id);
    })
    .then(infoDoc => {
      if (!infoDoc.initial_replication_date) {
        infoDoc.initial_replication_date = new Date();
      }

      infoDoc.latest_replication_date = new Date();
      return db.sentinel.put(infoDoc)
        .catch(err => {
          if (err.status === 409) {
            return updateOne(id);
          }

          throw err;
        });
    });
};

const updateMany = ids => {
  const infoDocIds = ids.map(getInfoDocId);

  return db.sentinel.allDocs({
    keys: infoDocIds,
    include_docs: true
  }).then(results => {
    const updatedInfoDocs = results.rows.map(row => {
      const infoDoc = row.doc || newInfoDoc(getDataDocId(row.key));

      if (!infoDoc.initial_replication_date) {
        infoDoc.initial_replication_date = new Date();
      }

      infoDoc.latest_replication_date = new Date();

      return infoDoc;
    });

    return db.sentinel.bulkDocs(updatedInfoDocs)
      .then(bulkResults => {
        const conflictingIds = bulkResults
          .filter(r => r.error === 'conflict')
          .map(r => getDataDocId(r.id));

        if (conflictingIds.length > 0) {
          return updateMany(conflictingIds);
        }
      });
  });
};


module.exports = {
  updateOne: updateOne,
  updateMany: updateMany
};
