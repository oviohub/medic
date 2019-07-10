const assert = require('chai').assert,
  sinon = require('sinon').createSandbox(),
  lib = require('../src/infodoc');

describe('infodoc', () => {
  const _ = () => { throw Error('unimplemented test stub'); };

  const db = {
    medic: {
      allDocs: _,
      bulkDocs: _,
      get: _,
      remove: _
    },
    sentinel: {
      allDocs: _,
      bulkDocs: _,
      get: _,
      put: _
    }
  };

  lib.initLib(db.medic, db.sentinel);

  afterEach(() => sinon.restore());

  describe('get', () => {
    it('gets an infodoc in sentinel based given a Change', () => {
      const change = {
        id: 'test'
      };
      const infodoc = {
        _id: 'test-info',
        _rev: '1-abc',
        type: 'info',
        doc_id: 'test',
        initial_replication_date: new Date(),
        latest_replication_date: new Date(),
        transitions: {}
      };
      const sentinelGet = sinon.stub(db.sentinel, 'get').resolves(infodoc);
      return lib.get(change)
        .then(result => {
          assert.equal(sentinelGet.callCount, 1);
          assert.equal(sentinelGet.args[0][0], 'test-info');
          assert.deepEqual(result, infodoc);
        });
    });

    it('transparently migrates a change from the medic db to the sentinel db if required', () => {
      const change = {
        id: 'test'
      };
      const infodoc = {
        _id: 'test-info',
        _rev: '1-abc',
        type: 'info',
        doc_id: 'test',
        initial_replication_date: new Date(),
        latest_replication_date: new Date(),
        transitions: {
          some: 'existing transition data'
        }
      };
      const sentinelGet = sinon.stub(db.sentinel, 'get').rejects({status: 404});
      const sentinelPut = sinon.stub(db.sentinel, 'put').resolves({rev: '1-cba'});
      const medicGet = sinon.stub(db.medic, 'get').resolves(Object.assign({}, infodoc));
      const medicRemove = sinon.stub(db.medic, 'remove').resolves();
      return lib.get(change)
        .then(result => {
          assert.equal(sentinelGet.callCount, 1);
          assert.equal(medicGet.callCount, 1);
          assert.equal(sentinelPut.callCount, 1);
          assert.equal(medicRemove.callCount, 1);
          assert.deepEqual(medicRemove.args[0], ['test-info', '1-abc']); // and deleting the medic version
          infodoc._rev = '1-cba';
          assert.deepEqual(result, infodoc);
        });
    });

    it('creates a blank infodoc in the sentinel db if none already exist', () => {
      const change = {
        id: 'test'
      };
      const sentinelGet = sinon.stub(db.sentinel, 'get').rejects({status: 404});
      const medicGet = sinon.stub(db.medic, 'get').rejects({status: 404});
      const sentinelPut = sinon.stub(db.sentinel, 'put').resolves({rev: '1-cba'});

      return lib.get(change)
        .then(result => {
          assert.equal(sentinelGet.callCount, 1);
          assert.equal(medicGet.callCount, 1);
          assert.equal(sentinelPut.callCount, 1);

          assert.deepEqual(result, {
            _id: 'test-info',
            _rev: '1-cba',
            type: 'info',
            doc_id: 'test',
            initial_replication_date: 'unknown',
            latest_replication_date: 'unknown',
            transitions: {}
          });
        });
    });

    it('handles conflicts when storing the infodoc in sentinel', () => {
      const change = {
        id: 'test'
      };
      const infodoc = {
        _id: 'test-info',
        _rev: '1-abc',
        type: 'info',
        doc_id: 'test',
        initial_replication_date: new Date(),
        latest_replication_date: new Date(),
        transitions: {}
      };

      const sentinelGet = sinon.stub(db.sentinel, 'get');
      sentinelGet.onFirstCall().rejects({status: 404});
      sentinelGet.onSecondCall().resolves(Object.assign({}, infodoc));
      const medicGet = sinon.stub(db.medic, 'get').rejects({status: 404});
      const sentinelPut = sinon.stub(db.sentinel, 'put');
      sentinelPut.onFirstCall().rejects({status: 409});
      // We should never actully call this second put, but this is what would happen if we did.
      // Since when we try to write the doc we 409 we can then restart the process and get the
      // now existing doc: no new doc needed so no writing needed.
      sentinelPut.onSecondCall().resolves({rev: '2-cba'});

      return lib.get(change)
        .then(result => {
          assert.equal(sentinelGet.callCount, 2); // 404, then now-existing doc
          assert.equal(medicGet.callCount, 1); // after the the first 404, not needed again
          assert.equal(sentinelPut.callCount, 1); // 409, then not called again

          assert.deepEqual(result, infodoc);
        });
    });
  });

  describe('delete', () => {
    it('deleteInfo doc handles missing info doc', () => {
      const given = { id: 'abc' };
      sinon.stub(db.sentinel, 'get').rejects({ status: 404 });
      return lib.delete(given);
    });

    it('deleteInfoDoc deletes info doc', () => {
      const given = { id: 'abc' };
      const get = sinon
        .stub(db.sentinel, 'get')
        .resolves({ _id: 'abc', _rev: '123' });
      const insert = sinon.stub(db.sentinel, 'put').resolves({});
      return lib.delete(given).then(() => {
        assert.equal(get.callCount, 1);
        assert.equal(get.args[0][0], 'abc-info');
        assert.equal(insert.callCount, 1);
        assert.equal(insert.args[0][0]._deleted, true);
      });
    });
  });

  describe('bulkGet', () => {
    it('should do nothing when parameter is empty', () => {
      sinon.stub(db.sentinel, 'allDocs');
      sinon.stub(db.medic, 'allDocs');

      return Promise
        .all([
          lib.bulkGet(),
          lib.bulkGet(false),
          lib.bulkGet([])
        ])
        .then(results => {
          assert.equal(results[0], undefined);
          assert.equal(results[1], undefined);
          assert.equal(results[2], undefined);

          assert.equal(db.sentinel.allDocs.callCount, 0);
          assert.equal(db.medic.allDocs.callCount, 0);
        });
    });

    it('should return infodocs when all are found in sentinel db', () => {
      const changes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            infoDocs = [{ _id: 'a-info' }, { _id: 'b-info' }, { _id: 'c-info' }];

      sinon.stub(db.sentinel, 'allDocs')
        .resolves({ rows: infoDocs.map(doc => ({ key: doc._id, doc }))});
      sinon.stub(db.medic, 'allDocs');

      return lib.bulkGet(changes).then(result => {
        assert.deepEqual(result, [
          { _id: 'a-info' },
          { _id: 'b-info' },
          { _id: 'c-info' }
        ]);

        assert.equal(db.sentinel.allDocs.callCount, 1);
        assert.deepEqual(db.sentinel.allDocs.args[0], [{ keys: ['a-info', 'b-info', 'c-info'], include_docs: true }]);
        assert.equal(db.medic.allDocs.callCount, 0);
      });
    });

    it('should return infodocs when all are found in medic db', () => {
      const changes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            infoDocs = [{ _id: 'a-info', _rev: 'a-r' }, { _id: 'b-info', _rev: 'b-r' }, { _id: 'c-info', _rev: 'c-r' }];

      sinon.stub(db.sentinel, 'allDocs')
        .resolves({ rows: infoDocs.map(doc => ({ key: doc._id, error: 'not_found' }))});
      sinon.stub(db.medic, 'allDocs')
        .resolves({ rows: infoDocs.map(doc => ({ key: doc._id, doc }))});

      return lib.bulkGet(changes).then(result => {
        assert.deepEqual(result, [
          { _id: 'a-info', _rev: 'a-r', legacy: true },
          { _id: 'b-info', _rev: 'b-r', legacy: true },
          { _id: 'c-info', _rev: 'c-r', legacy: true }
        ]);

        assert.equal(db.sentinel.allDocs.callCount, 1);
        assert.deepEqual(db.sentinel.allDocs.args[0], [{ keys: ['a-info', 'b-info', 'c-info'], include_docs: true }]);
        assert.equal(db.medic.allDocs.callCount, 1);
        assert.deepEqual(db.medic.allDocs.args[0], [{ keys: ['a-info', 'b-info', 'c-info'], include_docs: true }]);
      });
    });

    it('should generate infodocs if they do not already exist', () => {
      const changes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

      sinon.stub(db.sentinel, 'allDocs')
        .resolves({ rows: changes.map(doc => ({ key: `${doc.id}-info`, error: 'not_found' }))});
      sinon.stub(db.medic, 'allDocs')
        .resolves({ rows: changes.map(doc => ({ key: `${doc.id}-info`, error: 'not_found' }))});

      return lib.bulkGet(changes).then(result => {
        assert.deepEqual(result, [
          { _id: 'a-info', type: 'info', doc_id: 'a', initial_replication_date: 'unknown', latest_replication_date: 'unknown', transitions: {} },
          { _id: 'b-info', type: 'info', doc_id: 'b', initial_replication_date: 'unknown', latest_replication_date: 'unknown', transitions: {} },
          { _id: 'c-info', type: 'info', doc_id: 'c', initial_replication_date: 'unknown', latest_replication_date: 'unknown', transitions: {} }
        ]);

        assert.equal(db.sentinel.allDocs.callCount, 1);
        assert.deepEqual(db.sentinel.allDocs.args[0], [{ keys: ['a-info', 'b-info', 'c-info'], include_docs: true }]);
        assert.equal(db.medic.allDocs.callCount, 1);
        assert.deepEqual(db.medic.allDocs.args[0], [{ keys: ['a-info', 'b-info', 'c-info'], include_docs: true }]);
      });
    });

    it('should work with a mix of all', () => {
      const changes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }];

      sinon.stub(db.sentinel, 'allDocs')
        .resolves({ rows: [
            { key: 'a-info', id: 'a-info', doc: { _id: 'a-info', _rev: 'a-r', doc_id: 'a' } },
            { key: 'b-info', error: 'not_found' },
            { key: 'c-info', error: 'deleted' },
            { key: 'd-info', id: 'd-info', doc: { _id: 'd-info', _rev: 'd-r', doc_id: 'd' } },
            { key: 'e-info', error: 'deleted' },
            { key: 'f-info', error: 'something' },
          ]});
      sinon.stub(db.medic, 'allDocs')
        .resolves({ rows: [
            { key: 'b-info', id: 'b-info', doc: { _id: 'b-info', _rev: 'b-r', doc_id: 'b' } },
            { key: 'c-info', error: 'some error' },
            { key: 'e-info', error: 'some error' },
            { key: 'f-info', id: 'f-info', doc: { _id: 'f-info', _rev: 'f-r', doc_id: 'f' } },
          ]});

      return lib.bulkGet(changes).then(result => {
        assert.deepEqual(result, [
          { _id: 'a-info', _rev: 'a-r', doc_id: 'a' },
          { _id: 'd-info', _rev: 'd-r', doc_id: 'd' },
          { _id: 'b-info', _rev: 'b-r', doc_id: 'b', legacy: true },
          { _id: 'c-info', doc_id: 'c', initial_replication_date: 'unknown', latest_replication_date: 'unknown', type: 'info', transitions: {} },
          { _id: 'e-info', doc_id: 'e', initial_replication_date: 'unknown', latest_replication_date: 'unknown', type: 'info', transitions: {} },
          { _id: 'f-info', _rev: 'f-r', doc_id: 'f', legacy: true },
        ]);

        assert.equal(db.sentinel.allDocs.callCount, 1);
        assert.deepEqual(
          db.sentinel.allDocs.args[0],
          [{ keys: ['a-info', 'b-info', 'c-info', 'd-info', 'e-info', 'f-info'], include_docs: true } ]
        );
        assert.equal(db.medic.allDocs.callCount, 1);
        assert.deepEqual(
          db.medic.allDocs.args[0],
          [{ keys: ['b-info', 'c-info', 'e-info', 'f-info'], include_docs: true }]
        );
      });
    });

    it('should throw sentinel all docs errors', () => {
      sinon.stub(db.sentinel, 'allDocs').rejects({ some: 'error' });

      return lib
        .bulkGet([{ id: 'a' }])
        .then(() => assert.fail())
        .catch(err => assert.deepEqual(err, { some: 'error' }));
    });

    it('should throw medic all docs errors', () => {
      sinon.stub(db.sentinel, 'allDocs').resolves({ rows: [{ key: 'a', error: true }] });
      sinon.stub(db.medic, 'allDocs').rejects({ some: 'error' });

      return lib
        .bulkGet([{ id: 'a' }])
        .then(() => assert.fail())
        .catch(err => assert.deepEqual(err, { some: 'error' }));
    });
  });

  describe('bulkUpdate', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('should do nothing when docs list is empty', () => {
      sinon.stub(db.sentinel, 'bulkDocs');
      sinon.stub(db.medic, 'bulkDocs');

      return Promise
        .all([
          lib.bulkUpdate(),
          lib.bulkUpdate(false),
          lib.bulkUpdate([])
        ])
        .then(() => {
          assert.equal(db.sentinel.bulkDocs.callCount, 0);
          assert.equal(db.medic.bulkDocs.callCount, 0);
        });
    });

    it('should save all docs when none are legacy', () => {
      sinon.stub(db.sentinel, 'bulkDocs').resolves([{}, {}, {}, {}]);
      sinon.stub(db.medic, 'bulkDocs');

      const infoDocs = [ { _id: 'a-info' }, { _id: 'b-info' }, { _id: 'c-info' }, { _id: 'd-info' } ];

      return lib.bulkUpdate(infoDocs).then(() => {
        assert.equal(db.sentinel.bulkDocs.callCount, 1);
        assert.deepEqual(db.sentinel.bulkDocs.args[0], [[
          { _id: 'a-info' },
          { _id: 'b-info' },
          { _id: 'c-info' },
          { _id: 'd-info' }
        ]]);
        assert.equal(db.medic.bulkDocs.callCount, 0);
      });
    });

    it('should delete legacy docs after saving', () => {
      sinon.stub(db.sentinel, 'bulkDocs').resolves([{}, {}, {}, {}, {}]);
      sinon.stub(db.medic, 'bulkDocs').resolves();

      const infoDocs = [
        { _id: 'a-info', type: 'info', _rev: 'a-rev', legacy: true },
        { _id: 'b-info', type: 'info', _rev: 'b-rev', legacy: true },
        { _id: 'c-info', type: 'info', _rev: 'c-rev', legacy: true },
        { _id: 'd-info', type: 'info', _rev: 'd-rev' },
        { _id: 'e-info', type: 'info', _rev: 'e-rev' }
      ];

      return lib.bulkUpdate(infoDocs).then(() => {
        assert.equal(db.sentinel.bulkDocs.callCount, 1);
        assert.deepEqual(db.sentinel.bulkDocs.args[0], [[
          { _id: 'a-info', type: 'info' },
          { _id: 'b-info', type: 'info' },
          { _id: 'c-info', type: 'info' },
          { _id: 'd-info', type: 'info', _rev: 'd-rev' },
          { _id: 'e-info', type: 'info', _rev: 'e-rev' }
        ]]);

        assert.equal(db.medic.bulkDocs.callCount, 1);
        assert.deepEqual(db.medic.bulkDocs.args[0], [[
          { _id: 'a-info', type: 'info', _rev: 'a-rev', _deleted: true },
          { _id: 'b-info', type: 'info', _rev: 'b-rev', _deleted: true },
          { _id: 'c-info', type: 'info', _rev: 'c-rev', _deleted: true },
        ]]);
      });
    });

    it('intelligently handles conflicts when storing the infodocs in sentinel', () => {
      const initialInfoDocs = [
        {
          _id: 'test-info',
          this: 'one will not conflict'
        },
        {
          _id: 'test2-info',
          this: 'one will',
          initial_replication_date: 'unknown',
          latest_replication_date: 'unknown',
          transitions: {
            'new': 'transition data'
          }
        }
      ];

      const sentinelBulkDocs = sinon.stub(db.sentinel, 'bulkDocs');
      const sentinelAllDocs = sinon.stub(db.sentinel, 'allDocs');
      sentinelBulkDocs.onFirstCall().resolves([
        {
          ok: true,
          id: 'test-info',
          rev: '1-abc'
        },
        {
          id: 'test2-info',
          error: 'conflict',
          reason: 'Document update conflict.'
        }
      ]);
      sentinelAllDocs.resolves({rows: [
        {
          doc: {
            _id: 'test2-info',
            extra: 'data',
            initial_replication_date: new Date(),
            latest_replication_date: new Date(),
            transitions: {
              'old': 'transition data'
            }
          }
        }
      ]});
      sentinelBulkDocs.onSecondCall().resolves([
        {
          ok: true,
          id: 'test2-info',
          rev: '2-abc'
        },
      ]);

      return lib.bulkUpdate(initialInfoDocs)
        .then(() => {
          assert.equal(sentinelBulkDocs.callCount, 2);
          assert.equal(sentinelAllDocs.callCount, 1);
          assert.deepEqual(sentinelAllDocs.args[0][0].keys, ['test2-info']);
          const conflictWrite = sentinelBulkDocs.args[1][0][0];
          assert.isOk(conflictWrite.initial_replication_date instanceof Date);
          assert.isOk(conflictWrite.latest_replication_date instanceof Date);
          assert.deepEqual(conflictWrite.transitions, {'new': 'transition data'});
        });
    });
  });

  describe('updateTransition(s)', () => {
    it('updateTransition should set transition data', () => {
      const change = { seq: 12, doc: { _rev: 2 }, info: {}};
      lib.updateTransition(change, 'update_clinics', true);
      assert.deepEqual(
        change.info,
        {
          transitions: {
            update_clinics: { ok: true, seq: 12, last_rev: 2 }
          }
        });
      lib.updateTransition(change, 'accept_patient_reports', false);
      assert.deepEqual(
        change.info,
        {
          transitions: {
            update_clinics: { ok: true, seq: 12, last_rev: 2 },
            accept_patient_reports: { ok: false, seq: 12, last_rev: 2 }
          }
        });
    });

    it('saveTransitions should update infodoc', () => {
      const info = { _id: 'some-info', doc_id: 'some' };
      const change = {
        id: 'some',
        seq: 'seq',
        doc: { _rev: '123' },
        info: {
          _id: 'some-info',
          transitions: {
            one: { ok: true },
            two: { ok: false },
            three: { ok: true }
          }
        }
      };
      sinon.stub(db.sentinel, 'get').resolves(info);
      sinon.stub(db.sentinel, 'put').resolves();

      return lib.saveTransitions(change).then(() => {
        assert.equal(db.sentinel.get.callCount, 1);
        assert.deepEqual(db.sentinel.get.args[0], ['some-info']);
        assert.equal(db.sentinel.put.callCount, 1);
        assert.deepEqual(db.sentinel.put.args[0], [Object.assign(info, { transitions: change.info.transitions})]);
      });
    });

    it('should handle conflicts correctly', () => {
      const info = { _id: 'some-info', doc_id: 'some' };
      const change = {
        id: 'some',
        seq: 'seq',
        doc: { _rev: '123' },
        info: {
          _id: 'some-info',
          transitions: {
            one: { ok: true },
            two: { ok: false },
            three: { ok: true }
          }
        }
      };
      sinon.stub(db.sentinel, 'get').resolves(info);
      const sentinelPut = sinon.stub(db.sentinel, 'put');
      sentinelPut.onFirstCall().rejects({status: 409});
      sentinelPut.onSecondCall().resolves();

      return lib.saveTransitions(change).then(() => {
        assert.equal(db.sentinel.get.callCount, 2);
        assert.equal(db.sentinel.put.callCount, 2);
      });
    });
  });

  describe('recordDocumentWrites', () => {
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

        return lib.recordDocumentWrite('blah')
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

        return lib.recordDocumentWrite('blah')
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

        return lib.recordDocumentWrite('blah')
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
          initial_replication_date: new Date(),
          some_new: 'info'
        });
        sentinelPut.onFirstCall().rejects({status: 409});
        sentinelPut.onSecondCall().resolves();

        return lib.recordDocumentWrite('blah')
          .then(() => {
            assert.equal(sentinelGet.callCount, 2);
            assert.equal(sentinelPut.callCount, 2);
            assert.notEqual(sentinelPut.args[1][0].latest_replication_date, 'old date');
            assert.ok(sentinelPut.args[1][0].latest_replication_date instanceof Date);
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

        return lib.recordDocumentWrites(['new-doc', 'existing-doc'])
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

        return lib.recordDocumentWrites(['new-doc', 'another-new-doc', 'existing-doc', 'another-existing-doc'])
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
});
