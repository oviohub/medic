const config = require('./config'),
      db = require('./db'),
      logger = require('./lib/logger');

let inited = false;

module.exports = (sourceDb, settings, translations, sourceLogger) => {
  if (!inited) {
    logger.init(sourceLogger);
    db.init(sourceDb);
    inited = true;
  }
  config.init(settings, translations);

  const infodoc = require('@medic/infodoc');
  infodoc.initLib(db.medic, db.sentinel);

  const transitions = require('./transitions');
  return {
    loadTransitions: transitions.loadTransitions,
    processChange: transitions.processChange,
    processDocs: transitions.processDocs,
    messages: require('./lib/messages'),
    date: require('./date'),
    infodoc: infodoc,
    dueTasks: require('./schedule/due_tasks')
  };
};
