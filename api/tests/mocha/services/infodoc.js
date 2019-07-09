const sinon = require('sinon');
const assert = require('chai').assert;

const db = require('../../../src/db');

const service = require('../../../src/services/infodoc');

describe('infodoc service', () => {
  describe('update one', () => {
    let sentinelGet, sentinelPut;
    beforeEach(() => {
      sentinelGet = sinon.stub(db.sentinel, 'get');
      sentinelPut = sinon.stub(db.sentinel, 'put');
    });
    afterEach(() => sinon.restore());

    it('creates a new infodoc if it does not exist', () => {
      sentinelGet.rejects({status: 404});
      sentinelPut.resolves();

      return service.updateOne('blah')
        .then(() => {
          assert.equal(sentinelGet.callCount, 1);
          assert.equal(sentinelPut.callCount, 1);
          assert.notEqual(sentinelPut.args[0][0].latest_replication_date, 'old date');
          assert.ok(sentinelPut.args[0][0].latest_replication_date instanceof Date);
          assert.ok(sentinelPut.args[0][0].initial_replication_date instanceof Date);
        });
    });

    it('updates the latest replication date on an existing infodoc', () => {
      sentinelGet.resolves({
        _id: 'blah-info',
        latest_replication_date: 'old date'
      });
      sentinelPut.resolves();

      return service.updateOne('blah')
        .then(() => {
          assert.equal(sentinelGet.callCount, 1);
          assert.equal(sentinelPut.callCount, 1);
          assert.ok(sentinelPut.args[0][0].latest_replication_date instanceof Date);
        });
    });

    it('it handles 409s correctly when editing an infodoc', () => {
      sentinelGet.onFirstCall().resolves({
        _id: 'blah-info',
        latest_replication_date: 'old date'
      });
      sentinelGet.onSecondCall().resolves({
        _id: 'blah-info',
        latest_replication_date: 'old date',
        some_new: 'info'
      });
      sentinelPut.onFirstCall().rejects({status: 409});
      sentinelPut.onSecondCall().resolves();

      return service.updateOne('blah')
        .then(() => {
          assert.equal(sentinelGet.callCount, 2);
          assert.equal(sentinelPut.callCount, 2);
          assert.ok(sentinelPut.args[1][0].latest_replication_date instanceof Date);
          assert.equal(sentinelPut.args[1][0].some_new, 'info');
        });
    });

    it('it handles 409s correctly when creating an infodoc', () => {
      sentinelGet.onFirstCall().rejects({status: 404});
      sentinelGet.onSecondCall().resolves({
        _id: 'blah-info',
        some_new: 'info'
      });
      sentinelPut.onFirstCall().rejects({status: 409});
      sentinelPut.onSecondCall().resolves();

      return service.updateOne('blah')
        .then(() => {
          assert.equal(sentinelGet.callCount, 2);
          assert.equal(sentinelPut.callCount, 2);
          assert.notEqual(sentinelPut.args[1][0].latest_replication_date, 'old date');
          assert.ok(sentinelPut.args[1][0].latest_replication_date instanceof Date);
          assert.ok(sentinelPut.args[1][0].initial_replication_date instanceof Date);
          assert.equal(sentinelPut.args[1][0].some_new, 'info');
        });
    });
  });

  describe('update many', () => {
    let sentinelAllDocs, sentinelBulkDocs;
     beforeEach(() => {
      sentinelAllDocs = sinon.stub(db.sentinel, 'allDocs');
      sentinelBulkDocs = sinon.stub(db.sentinel, 'bulkDocs');
    });
    afterEach(() => sinon.restore());

    it('creates new infodocs and updates existing infodocs', () => {
      sentinelAllDocs.resolves({
        rows: [
          {
            key: 'new-doc-info',
            error: 'not_found'
          },
          {
            id: 'existing-doc-info',
            key: 'existing-doc-info',
            doc: {
              _id: 'existing-doc-info',
              initial_replication_date: 'ages ago',
              latest_replication_date: 'old date'
            }
          }
        ]
      });
      sentinelBulkDocs.resolves([
        {
          ok: true,
          id: 'new-doc-info',
          rev: '1-abc'
        },
        {
          ok: true,
          id: 'existing-doc-info',
          rev: '2-abc'
        },
      ]);

      return service.updateMany(['new-doc', 'existing-doc'])
        .then(() => {
          assert.equal(sentinelAllDocs.callCount, 1);
          assert.equal(sentinelBulkDocs.callCount, 1);
          assert.equal(sentinelBulkDocs.args[0][0][0]._id, 'new-doc-info');
          assert.ok(sentinelBulkDocs.args[0][0][0].latest_replication_date instanceof Date);
          assert.ok(sentinelBulkDocs.args[0][0][0].initial_replication_date instanceof Date);

          assert.equal(sentinelBulkDocs.args[0][0][1]._id, 'existing-doc-info');
          assert.ok(sentinelBulkDocs.args[0][0][1].latest_replication_date instanceof Date);
          assert.equal(sentinelBulkDocs.args[0][0][1].initial_replication_date, 'ages ago');
        });
    });
    it('Correctly works through and resolves conflicts when editing or creating infodocs', () => {
      // Attempting against two new docs and two existing
      sentinelAllDocs.onFirstCall().resolves({
        rows: [
          {
            key: 'new-doc-info',
            error: 'not_found'
          },
          {
            key: 'another-new-doc-info',
            error: 'not_found'
          },
          {
            id: 'existing-doc-info',
            key: 'existing-doc-info',
            doc: {
              _id: 'existing-doc-info',
              _rev: '1-abc',
              initial_replication_date: 'ages ago',
              latest_replication_date: 'old date'
            }
          },
          {
            id: 'another-existing-doc-info',
            key: 'another-existing-doc-info',
            doc: {
              _id: 'another-existing-doc-info',
              _rev: '1-abc',
              initial_replication_date: 'ages ago',
              latest_replication_date: 'old date'
            }
          }
        ]
      });
      // When we try to push changes: one new and one existing work fine, but the other two have conflicts!
      sentinelBulkDocs.onFirstCall().resolves([
        {
          ok: true,
          id: 'new-doc-info',
          rev: '1-abc'
        },
        {
          id: 'another-new-doc-info',
          error: 'conflict',
          reason: 'Document update conflict.'
        },
        {
          ok: true,
          id: 'existing-doc-info',
          rev: '2-abc'
        },
        {
          id: 'another-existing-doc-info',
          error: 'conflict',
          reason: 'Document update conflict.'
        },
      ]);
      // So we start again just for those conflicting two, getting them again...
      sentinelAllDocs.onSecondCall().resolves({
        rows: [
          {
            key: 'another-new-doc-info',
            doc: {
              _id: 'another-new-doc-info',
              _rev: '1-abc',
              some_new: 'data'
            }
          },
          {
            id: 'another-existing-doc-info',
            key: 'another-existing-doc-info',
            doc: {
              _id: 'another-existing-doc-info',
              _rev: '2-abc',
              initial_replication_date: 'ages ago',
              latest_replication_date: 'old date',
              some_new: 'data'
            }
          }
        ]
      });
      // ... and writing them again!
      sentinelBulkDocs.onSecondCall().resolves([
        {
          ok: true,
          id: 'another-new-doc-info',
          rev: '2-abc'
        },
        {
          ok: true,
          id: 'another-existing-doc-info',
          rev: '3-abc'
        }
      ]);

      return service.updateMany(['new-doc', 'another-new-doc', 'existing-doc', 'another-existing-doc'])
        .then(() => {
          assert.equal(sentinelAllDocs.callCount, 2);
          assert.equal(sentinelBulkDocs.callCount, 2);
          assert.deepEqual(sentinelAllDocs.args[0][0].keys, ['new-doc-info', 'another-new-doc-info', 'existing-doc-info', 'another-existing-doc-info']);
          assert.deepEqual(sentinelAllDocs.args[1][0].keys, ['another-new-doc-info', 'another-existing-doc-info']);
          assert.deepEqual(sentinelBulkDocs.args[0][0].map(d => d._id), ['new-doc-info', 'another-new-doc-info', 'existing-doc-info', 'another-existing-doc-info']);
          assert.deepEqual(sentinelBulkDocs.args[1][0].map(d => d._id), ['another-new-doc-info', 'another-existing-doc-info']);
        });
    });
  });
});
