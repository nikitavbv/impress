'use strict';

// Impress Application Server Core

process.title = 'impress';

require('./registry');

api.test.runner.instance.wait();

global.impress = new api.events.EventEmitter();
impress.name = 'impress';
impress.isImpress = true;
impress.firstStart = true;
impress.workerType = process.env.WORKER_TYPE;
if (impress.workerType === 'long') {
  impress.workerApplications = [process.env.WORKER_APPNAME];
  impress.workerApplicationName = process.env.WORKER_APPNAME;
  impress.workerApplicationFile = process.env.WORKER_FILE;
  impress.isWorker = true;
} else {
  impress.isWorker = 'WORKER_SERVER_NAME' in process.env;
}
impress.isMaster = !impress.isWorker;
impress.workerId = impress.isMaster ? 0 : parseInt(process.env.WORKER_ID, 10);
impress.dir = process.cwd();
impress.isWin = process.platform.startsWith('win');
impress.applicationsDir = api.path.join(impress.dir, 'applications');
impress.moduleDir = api.path.dirname(__dirname);
impress.mode = process.env.IMPRESS_MODE || '';
impress.serverName = process.env.WORKER_SERVER_NAME;
impress.serverProto = process.env.WORKER_SERVER_PROTO;
impress.nextWorkerId = 1;
impress.applications = {};
impress.servers = {};
impress.serversCount = 0;
impress.serversStarted = 0;
impress.stat = { fork: 0, event: 0, req: 0, res: 0 };
impress.relative = path => path.substr(impress.dir.length);

impress.DEFAULT_KEEP_ALIVE = api.common.duration('5s');
impress.DEFAULT_TIMEOUT = api.common.duration('30s');

{
  const submodules = [
    'constants', 'stack', 'application', 'scheduler', 'scripts',
    'workers', 'files', 'templates', 'config', 'extensions', 'cache',
    'health', 'firewall', 'client', 'state', 'security', 'cloud',
    'websocket', 'jstp'
  ];

  for (const submodule of submodules) {
    require('./' + submodule);
  }
}

// Fatal error with process termination
//   err <Error> | <string>
impress.fatalError = err => {
  if (!err.stack) err = new Error(err);
  const appName = impress.findApplicationByStack(err);

  let msg;
  if (err.code === 'EBIND') {
    msg = err.message;
  } else {
    msg = impress.shortenStack(err.stack);
  }

  if (!impress.log) {
    console.error(msg);
    impress.shutdown(1);
  }
  impress.log.error(msg);

  if (msg.includes('impress.createScript')) {
    const msg = 'Recover worker after throw Error in application: ';
    impress.log.system(msg + appName);
  } else {
    impress.log.system('Crashed');
    impress.shutdown(1);
  }
};

impress.accessLog = client => {
  const endTime = Date.now();
  let geo = '-';
  if (api.geoip) {
    const geoLocation = api.geoip.lookup(client.ip);
    if (geoLocation) {
      const { country, region, city } = geoLocation;
      geo = api.path.join(country, region, city);
    }
  }
  const { application, ip, socket, req, res, session } = client;
  const { bytesRead, bytesWritten } = socket;
  const { method, url, headers } = req;
  const code = res.statusCode;
  const elapsed = endTime - client.startTime;
  const time = elapsed.toString() + 'ms';
  const login = session ? session.login : '-';
  const token = session ? session.token : '-';
  const agent = headers['user-agent'] || '-';
  const referer = headers['referer'] || '-';
  const msg = `${time} ${ip} ${geo} ${login} ${token} ${bytesRead} ` +
    `${bytesWritten} ${method} ${code} ${url} ${agent} ${referer}`;
  application.log.access(msg);
  if (elapsed >= client.slowTime) application.log.slow(msg);
};

process.on('uncaughtException', err => {
  impress.fatalError(err);
});

process.on('warning', warning => {
  const stack = impress.shortenStack(warning.stack);
  impress.log.warn(`${warning.message} ${stack}`);
});

process.on('multipleResolves', (type, promise, repeated) => {
  const msg = `multipleResolves type: ${type}`;
  const sp = impress.shortenStack(api.util.inspect(promise));
  const sr = impress.shortenStack(api.util.inspect(repeated));
  impress.log.warn(`${msg}, first: ${sp}, repeated: ${sr}`);
});

process.on('unhandledRejection', reason => {
  const stack = impress.shortenStack(reason.stack);
  impress.log.warn(`unhandledRejection reason: ${stack}`);
});

process.on('rejectionHandled', promise => {
  const ser = impress.shortenStack(api.util.inspect(promise));
  impress.log.warn(`rejectionHandled promise: ${ser}`);
});

for (const arg of process.execArgv) {
  if (arg.startsWith('--max_old_space_size')) {
    const sp = arg.split('=');
    if (sp[1]) {
      impress.memoryLimit = parseInt(sp[1], 10) * impress.MEMORY_LIMIT;
    }
  }
}

// If memory limit detected we can check it periodically (5s by default)
// to prevent process exit or hang

if (impress.memoryLimit) {
  setInterval(() => {
    const before = process.memoryUsage();
    if (before.heapTotal < impress.memoryLimit) return;
    impress.cache.clear();
    for (const appName in impress.applications) {
      const application = impress.applications[appName];
      application.cache.clear();
    }
    const after = process.memoryUsage();
    if (after.heapTotal > impress.memoryLimit) {
      const mem = api.common.bytesToSize(after.heapTotal);
      impress.fatalError(`Memory limit exceeded: ${mem}, restarting`);
    }
  }, impress.MEMORY_LIMIT_CHECK_INTERVAL);
}

const compareHosts = () => {
  const compareMasks = (m1, m2) => m1 === m2 || m1 === '*' || m2 === '*';
  const cmp = [];
  for (const appName in impress.applications) {
    const config = impress.applications[appName].config.sections;
    if (!config) continue;
    const hosts = config.hosts;
    if (!hosts) continue;
    for (let i = 0; i < hosts.length; i++) {
      let hostFound = false;
      for (let j = 0; j < cmp.length; j++) {
        hostFound = hostFound || hosts[i] === cmp[j];
        if (compareMasks(hosts[i], cmp[j])) {
          impress.log.warn(
            `Hosts mask overlapping: "${hosts[i]}" and "${cmp[j]}"`
          );
        }
      }
      if (!hostFound) cmp.push(hosts[i]);
    }
  }
};

// Import/export namespaces after all applications loaded
const linkNamespaces = () => {
  for (const appName in impress.applications) {
    const application = impress.applications[appName];
    const sandboxConfig = application.config.sections.sandbox;
    if (!sandboxConfig) continue;
    const imp = sandboxConfig.import;
    if (!imp) continue;
    for (const impAppName in imp) {
      const impHash = imp[impAppName];
      if (!impHash) continue;
      const impApp = impress.applications[impAppName];
      if (!impApp) continue;
      const impSandbox = impApp.config.sections.sandbox;
      if (!impSandbox) continue;
      const exp = impSandbox.export;
      if (!exp) continue;
      for (const expObjName in impHash) {
        const impObjName = impHash[expObjName];
        const impObj = impSandbox[expObjName];
        if (exp.includes(expObjName)) {
          api.common.setByPath(application.sandbox, impObjName, impObj);
        } else {
          impress.log.warn(
            `Application ${appName} imports namespace ${expObjName}` +
            ` from ${impAppName} as ${impObjName} but it is not exported`
          );
        }
      }
    }
  }
};

const createApplications = callback => {
  api.metasync.each(impress.workerApplications, (appName, next) => {
    const dir = api.path.join(impress.applicationsDir, appName);
    api.fs.stat(dir, (err, stats) => {
      if (err || !stats.isDirectory()) {
        next();
        return;
      }
      const application = new impress.Application(appName, dir);
      impress.applications[application.name] = application;
      application.on('started', next);
    });
  }, () => {
    if (impress.serverProto === 'http') compareHosts();
    linkNamespaces();
    callback();
  });
};

const loadApplications = callback => {
  if (impress.isMaster) {
    callback();
    return;
  }
  if (impress.workerApplications) {
    createApplications(callback);
    return;
  }
  const config = impress.config.sections.servers[impress.serverName];
  if (config && config.applications) {
    impress.workerApplications = config.applications;
    createApplications(callback);
  } else {
    api.fs.readdir(impress.applicationsDir, (err, apps) => {
      if (err) {
        impress.fatalError(impress.CANT_READ_DIR + impress.applicationsDir);
        callback();
      } else {
        impress.workerApplications = apps;
        createApplications(callback);
      }
    });
  }
};

impress.initLogger = () => {
  const logDir = api.path.join(impress.dir, 'log');
  const config = impress.config.sections.log;
  const { writeInterval, writeBuffer, keepDays, toStdout, toFile } = config;
  api.mkdirp.sync(logDir);
  impress.logger = api.metalog({
    path: logDir, node: impress.nodeId,
    writeInterval, writeBuffer, keepDays,
    toStdout, toFile
  });
  impress.log = impress.logger.bind('impress');
};

const prepareServersConfig = () => {
  const configs = impress.config.sections.servers;
  const servers = {};
  impress.config.sections.servers = servers;
  for (const serverName in configs) {
    const config = configs[serverName];
    if (config.ports.length > 1) {
      const cpus = api.os.cpus().length;
      config.ports = api.common.sequence(config.ports, cpus);
    }
    for (let i = 0; i < config.ports.length; i++) {
      const port = config.ports[i];
      const server = Object.assign({}, config);
      server.port = port;
      const serviceName = serverName + (serverName === 'master' ? '' : port);
      if (server.inspect) server.inspect += i;
      servers[serviceName] = server;
    }
  }
};

const preload = () => {
  if (impress.workerType === 'long') {
    process.title = 'impress ' + impress.nodeId;
    const client = api.json.parse(process.env.WORKER_CLIENT);
    impress.workerApplicationClient = client;
    client.runScript = impress.Client.prototype.runScript;
    client.executeFunction = impress.Client.prototype.executeFunction;
  } else {
    process.title = 'impress ' + (
      impress.isMaster ? 'srv' : impress.nodeId
    );
  }
  const procType = impress.isMaster ? 'Master' : 'Worker';
  impress.processMarker = `${procType}(${process.pid}/${impress.nodeId})`;
  impress.load();
};

impress.start = () => {
  impress.config = new impress.Config(impress);
  impress.workers = {};
  impress.longWorkers = {};
  impress.cache = new impress.Cache(impress);
  impress.cache.init();
  impress.createSandbox(impress, () => {
    impress.config.loadConfig(() => {
      prepareServersConfig();
      const serverName = impress.config.sections.scale.server;
      impress.nodeId = serverName + 'N' + impress.workerId;
      impress.initLogger();
      impress.logger.on('open', () => {
        preload();
      });
    });
  });
};

// Establish IPC processing
const ipcStart = () => {
  process.on('SIGINT', impress.shutdown);
  process.on('SIGTERM', impress.shutdown);

  if (impress.isWorker) {
    process.on('message', message => {
      // Message is a first parameter
      // Second parameter usually used for socket handle
      const application = impress.applications[message.appName];
      if (message.name === 'impress:forklongworker') {
        delete message.name;
        if (application) application.workers[message.nodeId] = message;
      } else if (message.name === 'impress:exitlongworker') {
        if (application) delete application.workers[message.nodeId];
      }
    });
    process.on('beforeExit', code => {
      process.send({ name: 'impress:exit', code });
      impress.log.system('Worker terminated');
    });
  }
};

// Print information about started server to stdout and logs
//   server <Object>, server instance
const logServerStarted = server => {
  const { name, protocol, transport, address, port } = server.config;
  let protocolName = protocol.toUpperCase();
  if (transport === 'tls') {
    protocolName += 'S';
  } else if (transport === 'ws' || transport === 'wss') {
    protocolName += '/' + transport.toUpperCase();
  }
  const marker = impress.processMarker;
  let message = `${protocolName} listen on ${address}:${port} by ${marker}`;
  if (name === 'master') {
    const instanceType = impress.config.sections.scale.instance;
    if (instanceType === 'controller') {
      message += ' Cloud Controller';
    } else {
      message += ' Master Server';
    }
  }
  if (!server.instance) message += ' FAILED';
  impress.log.system(message);
};

const serverOnError = (err, address) => {
  if (['EADDRINUSE', 'EACCES'].includes(err.code)) {
    const msg = `Can't bind to ${address}`;
    if (impress.isWorker) {
      process.send({ name: 'impress:exit', error: msg });
    } else {
      const error = new Error(msg);
      error.code = 'EBIND';
      impress.fatalError(error);
    }
  }
};

// Send request timeout
const serverOnTimeout = socket => {
  const client = socket.client;
  if (!client || client.finished) {
    socket.destroy();
    return;
  }
  client.timedOut = true;
  client.error(408);
};

const configureServer = server => {
  server.instance.serverName = server.name;
  const { address, port, keepAlive, timeout, nagle } = server.config;

  server.instance.on('error', err => {
    serverOnError(err, `${address}:${port}`);
  });

  if (server.instance.setTimeout) {
    server.keepAlive = keepAlive || impress.DEFAULT_KEEP_ALIVE;
    const serverTimeout = timeout || impress.DEFAULT_TIMEOUT;
    server.instance.setTimeout(serverTimeout, serverOnTimeout);
  }

  if (!nagle) {
    server.instance.on('connection', socket => {
      socket.setNoDelay();
    });
  }
};

const startServer = server => {
  const { protocol, transport, address, port } = server.config;
  if (protocol === 'jstp') {
    server.instance = impress.jstp.createServer(server);
  } else if (protocol === 'http') {
    if (transport === 'tls') {
      const cert = impress.loadCertificates(server.config);
      if (cert) {
        server.instance = api.https.createServer(cert, impress.dispatcher);
      }
    } else {
      server.instance = api.http.createServer(impress.dispatcher);
    }
    if (server.instance) {
      api.websocket.upgradeServer(server.instance);
    }
  }

  logServerStarted(server);
  if (!server.instance) return;
  configureServer(server);

  if (address === '*') server.instance.listen(port);
  else server.instance.listen(port, address);
};

// Start JSTP and HTTP servers
const startServers = () => {
  const configServers = impress.config.sections.servers;
  const serverNames = Object.keys(configServers);
  impress.serversCount = serverNames.length;
  impress.serversStarted = 1;

  let workerId = 0;
  for (const serverName of serverNames) {
    const serverConfig = configServers[serverName];

    const server = {
      name: serverName,
      config: serverConfig,
      instance: null,
    };

    impress.servers[serverName] = server;

    if (impress.isMaster) {
      if (serverName === 'master') {
        startServer(server);
      } else if (impress.firstStart) {
        impress.forkWorker(workerId++, server);
      }
    } else if (serverName === impress.serverName) {
      startServer(server);
    }
  }
};

impress.load = () => {
  ipcStart();
  loadApplications(() => {
    if (impress.isMaster) {
      impress.log.system('Server started');
    } else {
      process.send({ name: 'impress:start', id: impress.workerId });
      impress.log.system('Worker forked');
    }
    if (impress.workerApplicationName) {
      const application = impress.applications[impress.workerApplicationName];
      impress.workerApplicationClient.application = application;
      impress.workerApplicationClient.access = { allowed: true };
      const file = impress.workerApplicationFile;
      impress.workerApplicationClient.runScript('worker', file, err => {
        if (err) impress.log.error(err);
        impress.logger.on('close', () => {
          process.exit(0);
        });
        impress.logger.close();
      });
    }
    if (!impress.isMaster && !impress.workerApplications) {
      const { servers } = impress.config.sections;
      for (const name in servers) {
        const config = servers[name];
        const server = impress.servers[name];
        if (server && config.protocol === 'jstp' && server.instance) {
          const apps = impress.jstp.prepareApplications();
          server.instance.updateApplications(apps);
        }
      }
    }
    impress.emit('loaded');
    if (impress.serverName && impress.serverName.indexOf('test') !== -1) {
      api.test.runner.instance.resume();
      api.test.test('Impress applications test', test => {
        test.endAfterSubtests();
        Object.keys(impress.applications).forEach(appName => {
          test.test(appName, test => {
            test.endAfterSubtests();
            impress.applications[appName].tests.unit
              .concat(impress.applications[appName].tests.integration)
              .forEach(testCase => test.test(testCase.path, testCase.test));
          });
        });
      });
    }
  });
  if (!impress.workerApplicationName) {
    startServers();
    api.health.init();
    api.cloud.init();
  }
  impress.gsInterval();
  impress.firstStart = false;
};

// Set garbage collection interval
impress.gsInterval = () => {
  if (typeof global.gc !== 'function') return;
  const interval = impress.config.sections.scale.gc;
  if (interval > 0) setInterval(global.gc, interval);
};

// Unload configuration and stop server
impress.stop = () => {
  impress.cache.clear();
  const servers = impress.servers;
  if (!servers) {
    impress.log.warn('No servers active');
    return;
  }
  for (const serverName in servers) {
    const server = servers[serverName];
    if (server.instance) {
      server.instance.close(() => {
        for (const appName in impress.applications) {
          const application = impress.applications[appName];
          application.emit('stop');
          application.scheduler.stopTasks();
          application.cache.clear();
        }
      });
    }
  }
};

impress.shutdown = (code = 0) => {
  if (impress.finalization) return;
  impress.finalization = true;
  if (impress.isMaster) {
    impress.killWorkers();
    impress.log.system('Stopped server');
    impress.logger.on('close', () => {
      setImmediate(() => {
        impress.stop();
        process.exit(code);
      });
    });
  } else {
    impress.log.system('Worker terminated');
    impress.logger.on('close', () => {
      process.exit(code);
    });
  }
  impress.logger.close();
};

// Load SSL certificates
//   server <Object> server configuration
impress.loadCertificates = config => {
  if (config.key && config.cert) {
    const certDir = api.path.join(impress.dir, 'config/ssl');
    const keyFile = api.path.join(certDir, config.key);
    const certFile = api.path.join(certDir, config.cert);
    try {
      const key = api.fs.readFileSync(keyFile);
      const cert = api.fs.readFileSync(certFile);
      return { key, cert };
    } catch (e) {
      impress.log.error('Certificate is not found');
    }
  } else {
    impress.log.error('Certificate is not configured for TLS');
  }
};

// Retranslate IPC event to all workers except one
//   exceptWorkerId <number>
//   message <string> message to retranslate
impress.retranslateEvent = (exceptWorkerId, message) => {
  exceptWorkerId += '';
  for (const workerId in impress.workers) {
    const worker = impress.workers[workerId];
    if (worker.channel && workerId !== exceptWorkerId) {
      worker.send(message);
    }
  }
};

// HTTP Dispatcher
//   req <IncomingMessage>
//   res <ServerResponse>
// Rerurns: <Client>
impress.dispatcher = (req, res) => {
  impress.stat.req++;
  const host = api.common.parseHost(req.headers.host);
  for (const appName in impress.applications) {
    const application = impress.applications[appName];
    const hosts = application.config.sections.hosts;
    let appFound = hosts && hosts.length !== 0;
    if (appFound && !hosts.includes(host)) {
      appFound = false;
      for (const configHost of hosts) {
        const index = configHost.indexOf('*');
        if (index !== -1 && host.startsWith(configHost.slice(0, index)) &&
          host.slice(index).endsWith(configHost.slice(0, index) + 1)) {
          appFound = true;
          break;
        }
      }
    }
    if (appFound) {
      if (application.ready) {
        const client = application.dispatch(req, res);
        return client;
      } else {
        const client = new impress.Client(impress, req, res);
        client.error(503);
        return client;
      }
    }
  }
  // No application detected to dispatch request
  const client = new impress.Client(impress, req, res);
  client.error(404);
  return client;
};

// Log API Method
//   fnPath <string> path to function to be wrapped
// Example: impress.logApiMethod('fs.stats')
impress.logApiMethod = fnPath => {
  const originalMethod = api.common.getByPath(api, fnPath);
  api.common.setByPath(api, fnPath, (...args) => {
    let callback = null;
    if (args.length > 0) {
      callback = args[args.length - 1];
      if (typeof callback === 'function') args.pop();
      else callback = null;
    }
    const logArgs = api.json.stringify(args);
    if (impress && impress.log) {
      const par = logArgs.substring(1, logArgs.length - 1);
      const msg = `${fnPath}(${par}, callback)`;
      impress.log.debug(msg);
      const stack = new Error().stack.split('\n');
      impress.log.system(stack[2].trim());
    }
    if (callback) {
      args.push((...args) => {
        const logArgs = api.json.stringify(args);
        if (impress && impress.log) {
          const par = logArgs.substring(1, logArgs.length - 1);
          const msg = `${fnPath} callback(${par})`;
          impress.log.debug(msg);
        }
        callback(...args);
      });
    }
    originalMethod(...args);
  });
};
