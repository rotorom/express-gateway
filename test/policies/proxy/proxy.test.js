const path = require('path');
const fs = require('fs');
const request = require('supertest');
const should = require('should');
const sinon = require('sinon');

const config = require('../../../lib/config');
const gateway = require('../../../lib/gateway');
const logger = require('../../../lib/logger').policy;
const { findOpenPortNumbers } = require('../../common/server-helper');

const originalGatewayConfig = config.gatewayConfig;

const serverKeyFile = path.join(__dirname, '../../fixtures/certs/server', 'server.key');
const serverCertFile = path.join(__dirname, '../../fixtures/certs/server', 'server.crt');
const invalidClientCertFile = path.join(__dirname, '../../fixtures', 'agent1-cert.pem');
const clientKeyFile = path.join(__dirname, '../../fixtures/certs/client', 'client.key');
const clientCertFile = path.join(__dirname, '../../fixtures/certs/client', 'client.crt');
const chainFile = path.join(__dirname, '../../fixtures/certs/chain', 'chain.pem');

let backendServerPort;

describe('@proxy policy', () => {
  const defaultProxyOptions = {
    target: {
      keyFile: clientKeyFile,
      certFile: clientCertFile,
      caFile: chainFile
    }
  };
  let app, backendServer;

  before('start HTTP server', (done) => {
    findOpenPortNumbers(1).then((ports) => {
      const https = require('https');
      const express = require('express');
      const expressApp = express();

      backendServerPort = ports[0];

      expressApp.all('*', function (req, res) {
        if (req.headers['x-test']) {
          res.setHeader('x-test', req.header('x-test'));
        }

        if (req.headers['x-forwarded-for']) {
          res.setHeader('x-forwarded-for', req.header('x-forwarded-for'));
        }

        res.status(200).json();
      });

      backendServer = https.createServer({
        key: fs.readFileSync(serverKeyFile),
        cert: fs.readFileSync(serverCertFile),
        ca: fs.readFileSync(chainFile),
        requestCert: true,
        rejectUnauthorized: true
      }, expressApp);

      backendServer.listen(backendServerPort, done);
    });
  });

  after('clean up', (done) => {
    config.gatewayConfig = originalGatewayConfig;
    backendServer.close(done);
  });

  describe('proxyOptions', () => {
    afterEach((done) => app ? app.close(done) : done());

    it('raises an error when incorrect TLS file paths are provided', () => {
      const serviceOptions = { target: { keyFile: '/non/existent/file.key' } };

      return should(setupGateway(serviceOptions)).be.rejectedWith(/no such file or directory/);
    });

    describe('when incorrect proxy options are provided', () => {
      before(() => {
        return setupGateway({ target: { certFile: invalidClientCertFile } }).then(apps => {
          app = apps.app;
        });
      });

      it('responds with a bad gateway error', () => expectResponse(app, 502, /text\/html/));
    });

    describe('When proxy options are specified on the policy action', () => {
      before(() => {
        return setupGateway(defaultProxyOptions).then(apps => {
          app = apps.app;
        });
      });

      it('passes options to proxy', () => expectResponse(app, 200, /json/));
    });

    describe('When proxy options are specified on the proxyOptions deprecated parameter', () => {
      let loggerSpy;
      before(() => {
        loggerSpy = sinon.spy(logger, 'warn');
        return setupGateway({ proxyOptions: defaultProxyOptions }).then(apps => {
          app = apps.app;
        });
      });

      after(() => loggerSpy.restore());

      it('passes options to proxy but emit a warning', () => {
        expectResponse(app, 200, /json/);
        should(loggerSpy.called).be.true();
      });
    });

    describe('When proxy options are specified on the serviceEndpoint', () => {
      before(() => {
        return setupGateway(undefined, defaultProxyOptions).then(apps => {
          app = apps.app;
        });
      });

      it('passes options to proxy', () => expectResponse(app, 200, /json/));
    });

    describe('When proxy options are scattered on all the supported properties', () => {
      before(() => {
        return setupGateway(Object.assign(defaultProxyOptions, { proxyOptions: { xfwd: true } }), { headers: { 'X-Test': 'testValue' } }).then(apps => {
          app = apps.app;
        });
      });

      it('passes options to proxy', () =>
        request(app)
          .get('/endpoint')
          .expect(200)
          .expect('x-test', 'testValue')
          .expect('x-forwarded-for', '::ffff:127.0.0.1')
      );
    });
  });
});

const setupGateway = (proxyOptions = {}, serviceProxyOptions = {}) =>
  findOpenPortNumbers(1).then(([port]) => {
    config.gatewayConfig = {
      http: { port },
      apiEndpoints: {
        test: {}
      },
      serviceEndpoints: {
        backend: {
          url: `https://localhost:${backendServerPort}`,
          proxyOptions: serviceProxyOptions
        }
      },
      policies: ['proxy'],
      pipelines: {
        pipeline1: {
          apiEndpoints: ['test'],
          policies: [{
            proxy: [{
              action: Object.assign({}, proxyOptions, { serviceEndpoint: 'backend' })
            }]
          }]
        }
      }
    };
    return gateway();
  });

const expectResponse = (app, status, contentType) =>
  request(app).get('/endpoint').expect(status).expect('Content-Type', contentType);
