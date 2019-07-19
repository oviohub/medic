const { assert } = require('chai');
const utils = require('../utils');
const sUtils = require('./sentinel/utils');

const delayedInfoDocOf = id => sUtils.waitForSentinel(id).then(() => sUtils.getInfoDoc(id));

describe('maintaining infodocs', () => {
  afterEach(utils.afterEach);

  const singleDocTest = method => {
    const doc = {
      _id: 'infodoc-maintain-on-' + method,
      some: 'data'
    };
    const path = method === 'PUT' ? `/${doc._id}` : '/';
    let infoDoc;
    let deleteRev;

    // First write...
    let infoWrite = delayedInfoDocOf(doc._id);
    return utils.requestOnTestDb({
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: doc
    }).then(result => {
      // ...should succeed and...
      assert.isTrue(result.ok);
      doc._rev = result.rev;
      doc.more = 'data';

      return infoWrite;
    }).then(result => {
      // ...create an info doc...
      assert.deepInclude(result, {
        _id: doc._id + '-info',
        type: 'info',
        doc_id: doc._id
      });
      // ...with the initial and latest replication dates set.
      assert.isOk(result.initial_replication_date);
      assert.isOk(result.latest_replication_date);

      infoDoc = result;

      // Second write with correct _rev...

      infoWrite = delayedInfoDocOf(doc._id);
      return utils.requestOnTestDb({
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: doc
      });
    }).then(result => {
      // ...should succeed and...
      assert.isTrue(result.ok);

      deleteRev = result.rev;

      return infoWrite;
    }).then(result => {
      // ...leave the initial date the same while changing the latest date.
      assert.equal(result.initial_replication_date, infoDoc.initial_replication_date);
      assert.notEqual(result.latest_replication_date, infoDoc.latest_replication_date);

      infoDoc = result;

      // Third write with the old _rev...
      infoWrite = delayedInfoDocOf(doc._id);
      return utils.requestOnTestDb({
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: doc
      }).catch(err => err);
    }).then(result => {
      // ...should fail with a conflict...
      assert.equal(result.statusCode, 409);

      return infoWrite;
    }).then(result => {
      // ...and the infodoc should remain the same.
      assert.equal(result.initial_replication_date, infoDoc.initial_replication_date);
      assert.equal(result.latest_replication_date, infoDoc.latest_replication_date);

      // A delete...
      doc._deleted = true;
      doc._rev = deleteRev;

      return utils.requestOnTestDb({
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: doc
      });
    }).then(result => {
      // ...should succeed...
      assert.isTrue(result.ok);

      // ..and the infodoc...
      return delayedInfoDocOf(doc._id)
        .catch(err => err);
    }).then(err => {
      // ... should be deleted.
      assert.equal(err.status, 404);
    });
  };

  // These tests are using an admin user
  // For infodoc tests that check that restricted user security is followed
  // correctly, see the tests for the action in question (e.g. bulk-docs.spec.js)
  describe('maintaining replication dates', () => {
    it('on PUT', () => singleDocTest('PUT'));
    it('on POST', () => singleDocTest('POST'));

    it('on bulk docs', () => {
      const docs = [
        {
          'no_id': 'to_begin_with'
        },
        {
          _id: 'written-to-twice-successfully'
        },
        {
          _id: 'first-write-works-second-fails'
        }
      ];

      let infoDocs;

      return utils.requestOnTestDb({
        path: '/_bulk_docs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: {docs: docs}
      }).then(result => {
        // ...should succeed for all docs
        assert.equal(result.filter(r => r.ok).length, 3);

        docs[0]._id = result[0].id;
        docs[0]._rev = result[0].rev;
        docs[1]._rev = result[1].rev;

        return Promise.all(docs.map(d => delayedInfoDocOf(d._id)));
      }).then(results => {
        infoDocs = results;

        // ...and create all of the infodocs.
        assert.equal(infoDocs.length, 3);
        infoDocs.forEach((infoDoc, idx) => {
          const doc = docs[idx];

          assert.deepInclude(infoDoc, {
            _id: doc._id + '-info',
            type: 'info',
            doc_id: doc._id
          }, `infodoc for ${doc._id} created correctly`);
          assert.isOk(infoDoc.initial_replication_date, `infodoc initial_replication_date for ${doc._id} exists`);
          assert.isOk(infoDoc.latest_replication_date, `infodoc latest_replication_date for ${doc._id} exists`);
        });

        // When we write docs for the second time...
        return utils.requestOnTestDb({
          path: '/_bulk_docs',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: {docs: docs}
        });
      }).then(result => {
        // ...we expect the first two to work (because we updated their revs)...
        assert.isTrue(result[0].ok);
        assert.isTrue(result[1].ok);
        // ...and the third to fail...
        assert.isNotOk(result[2].ok);

        docs[0]._rev = result[0].rev;
        docs[1]._rev = result[1].rev;

        return Promise.all(docs.map(d => delayedInfoDocOf(d._id)));
      }).then(newInfoDocs => {
        // ...which means that the first two latest_replication_date values should change...
        assert.notEqual(newInfoDocs[0].latest_replication_date, infoDocs[0].latest_replication_date);
        assert.notEqual(newInfoDocs[1].latest_replication_date, infoDocs[1].latest_replication_date);
        // ..and the last should not.
        assert.equal(newInfoDocs[2].latest_replication_date, infoDocs[2].latest_replication_date);

        docs.pop(); // (remove the failing one, we're done with it)

        // When we delete a doc...
        docs[1]._deleted = true;

        return utils.requestOnTestDb({
          path: '/_bulk_docs',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: {docs: docs}
        });
      }).then(result => {
        // ...everything should work...
        assert.isTrue(result[0].ok);
        assert.isTrue(result[1].ok);

        // ...and the second doc should not have a infodoc anymore
        return delayedInfoDocOf(docs[1]._id).catch(err => err);
      }).then(err => {
        assert.equal(err.status, 404);
      });
    });
  });
});
