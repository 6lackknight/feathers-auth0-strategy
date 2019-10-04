const assert = require('assert')
const feathers = require('@feathersjs/feathers')
const Auth0Strategy = require('../lib/strategy')
const Auth0Service = require('../lib/service')
const { authenticate, hooks } = require('@feathersjs/authentication')
const fromAuth0 = require('../lib/hooks/from-auth0')
const { connection, event } = hooks
const {
  app,
  fakeJWKS,
  signingCertificate,
  jwts,
  contexts
} = require('./test-vars')

// extend Auth0Strategy so we can override getJWKS with a mock
class MockAuth0Strategy extends Auth0Strategy {
  getJWKS (uri) {
    if (uri === 'https://bad.auth0.com/.well-known/jwks.json') {
      const copyOfFakeJWKS = JSON.parse(JSON.stringify(fakeJWKS))
      copyOfFakeJWKS.keys[0].kid = 'nonMatchingKid'
      return Promise.resolve(copyOfFakeJWKS)
    }
    if (uri === this.configuration.jwksUri) return Promise.resolve(fakeJWKS)
    throw 'The URI for the JWKS was incorrect'
  }
}

const clone = obj => JSON.parse(JSON.stringify(obj))

/**
 * This is what the configuration should be set to if only the
 * domain is set in the default.json config file
 */
const defaultConfig = {
  create: false,
  entity: 'user',
  entityId: 'user_id',
  header: 'Authorization',
  jwksUri: 'https://example.auth0.com/.well-known/jwks.json',
  jwtOptions: {
    algorithms: ['RS256'],
    audiences: [
      'https://example.auth0.com/api/v2',
      'https://example.auth0.com/userinfo'
    ],
    ignoreExpiration: false,
    issuer: 'https://example.auth0.com/'
  },
  schemes: ['Bearer', 'JWT'],
  service: 'users'
}

/**
 * The config value of the "authentication" key in default.json
 */
const config = { auth0: { domain: 'example.auth0.com' }, authStrategies: ['auth0'] }

describe('The Auth0Strategy', () => {
  let strategy

  before(() => {
    const service = new Auth0Service(app)
    strategy = new MockAuth0Strategy()
    service.register('auth0', strategy)
    app.use('/authentication', service)
  })

  it('is configured properly', () => {
    assert.deepEqual(strategy.configuration, defaultConfig, 'The strategy produces the wrong configuration')

    try {
      // unset the domain
      const noDomainConfig = clone(strategy.app.get('authentication'))
      delete noDomainConfig.auth0.domain
      strategy.app.set('authentication', noDomainConfig)
      strategy.verifyConfiguration()
      assert.fail('Should never get here')
    } catch (err) {
      assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
      assert.strictEqual(err.message, 'You must set `authentication.auth0.domain` in your app configuration.', 'Did not have the correct error message')
    }
    // restore the valid app config
    strategy.app.set('authentication', { auth0: { domain: 'example.auth0.com' } })
  })

  describe('getEntity() method', () => {
    it('is a function', () => {
      assert(typeof strategy.getEntity === 'function', 'getEntity() is not a function')
    })

    it('throws an error if the entity service cannot be found', async () => {
      const configuration = Object.assign({}, config, { auth0: { service: 'people' } })
      strategy.app.set('authentication', configuration)
      try {
        await strategy.getEntity('some_user_id', {})
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Could not find the "user" service', 'Did not have the correct error message')
      }
      strategy.app.set('authentication', config)
    })

    it('throws an error if no entity is found in the database and `create === false`', async () => {
      try {
        await strategy.getEntity('some_user_id', {})
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Could not find user with this user_id in the database')
      }
    })

    it('returns an entity if found in the database', async () => {
      await app.service('users').create({ user_id: 'auth0|0123456789' })
      const user = await strategy.getEntity('auth0|0123456789', {})
      assert.deepEqual(user.user_id, 'auth0|0123456789', 'The user was not retrieved')
    })

    it('creates a new entity if not found and `create === true`', async () => {
      app.set('authentication', {
        auth0: {
          create: true,
          domain: 'example.auth0.com'
        }
      })
      const user = await strategy.getEntity('auth0|iDoNotExist', {})
      // reset the configuration after we've made our request
      app.set('authentication', {
        auth0: {
          create: false,
          domain: 'example.auth0.com'
        }
      })
      assert.strictEqual(user.user_id, 'auth0|iDoNotExist', 'The user was not created')
    })
  })

  describe('getJWKS() method', () => {
    it('is a function', () => {
      assert(typeof strategy.getJWKS === 'function', 'getJWKS() is not a function')
    })

    it('returns a Promise when passed a uri (string)', () => {
      assert(
        strategy.getJWKS(strategy.configuration.jwksUri) instanceof Promise,
        'Calling getJWKS() with a valid URI parameter did not return a promise'
      )
    })

    it('returns a JWKS asynchronously', async () => {
      const jwks = await strategy.getJWKS(strategy.configuration.jwksUri)
      assert.deepEqual(jwks, fakeJWKS, 'getJWKS() client did not return the expected JWKS')
    })
  })

  describe('x5cToPEM() method', () => {
    it('is a function', () => {
      assert(typeof strategy.x5cToPEM === 'function', 'x5cToPEM() is not a function.')
    })

    it('extracts a key in PEM format from a JWK', () => {
      const pem = strategy.x5cToPEM(fakeJWKS.keys[0])
      assert.strictEqual(pem, signingCertificate, 'x5cToPEM() did not extract the expected key from the JWK')
    })

    it('throws an error if the JWK has no x5c elements', () => {
      try {
        const jwkWithNoX5C = JSON.parse(JSON.stringify(fakeJWKS.keys[0]))
        jwkWithNoX5C.x5c = []
        strategy.x5cToPEM(jwkWithNoX5C)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
        assert.strictEqual(err.message, 'JWK has no x5c property.', 'message should be \'JWK has no x5c property.\'')
      }
    })
  })

  describe('getJWK() method', () => {
    before(() => {
      strategy.app.set(strategy.authentication.configKey, config)
      strategy.jwks = new Map()
    })

    it('is a function', () => {
      assert(typeof strategy.getJWK === 'function', 'getJWK() is not a function.')
    })

    it('throws an error if key is not already in memory and the retrieved JWKS does not contain `kid`', async () => {
      try {
        strategy.app.set(strategy.authentication.configKey, { auth0: { domain: 'bad.auth0.com' }, authStrategies: ['auth0'] })
        await strategy.getJWK(jwts.currentMemberJWT)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Could not retrieve JWKS', 'message should be \'Could not retrieve JWKS\'')
        // reset the jwksUri
        strategy.app.set(strategy.authentication.configKey, config)
      }
    })

    it('sets the JWK (secret) if passed a well-formed access token', async () => {
      const jwk = await strategy.getJWK(jwts.currentMemberJWT)
      assert.strictEqual(jwk, signingCertificate, 'getJWK() did not set the expected PEM')
    })

    it('throws an error if the passed token is not well-formed', async () => {
      try {
        await strategy.getJWK('iamnotwellformed')
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'The access token was malformed or missing', 'message should be \'The access token was malformed or missing\'')
      }
    })

    it('will return a stored key if found in the database', async () => {
      strategy.jwks.set('goodKid', signingCertificate)
      await strategy.getJWK(jwts.currentMemberJWT)
      const key = strategy.jwks.get('goodKid')
      assert.equal(key, signingCertificate, 'getJWK() did not return the key expected')
    })
  })

  describe('authenticate() method', () => {
    it('is a function', () => {
      assert(typeof strategy.authenticate === 'function', 'authenticate() is not a function.')
    })

    it('throws an error if no accessToken is passed', async () => {
      try {
        await strategy.authenticate({ accessToken: null }, {})
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Token could not be verified', 'message should be \'Token could not be verified\'')
        assert.strictEqual(err.data.message, 'The access token was malformed or missing', 'message should be \'The access token was malformed or missing\'')
      }
    })

    it('throws an error if the accessToken is malformed', async () => {
      try {
        await strategy.authenticate({ accessToken: 'a_bad_token' }, {})
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Token could not be verified', 'message should be \'Token could not be verified\'')
        assert.strictEqual(err.data.message, 'The access token was malformed or missing', 'message should be \'The access token was malformed or missing\'')
      }
    })

    it('throws an error if the accessToken cannot be verified', async () => {
      try {
        // make sure a valid key is stored in the keys service
        strategy.jwks.set('goodKid', strategy.x5cToPEM(fakeJWKS.keys[0]))
        // add a valid user to the database
        await strategy.entityService.create({ user_id: 'auth0|currentValidTokenMember' })
        // try to authenticate with a JWT that was created with an invalid issuer URL
        await strategy.authenticate({ accessToken: jwts.invalidIssuerJWT }, {})
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Token could not be verified', 'message should be \'Token could not be verified\'')
      }
    })

    it('returns a valid access token and entity upon success', async () => {
      const result = await strategy.authenticate({ accessToken: jwts.currentMemberJWT }, {})
      assert.deepEqual(result, {
        accessToken: jwts.currentMemberJWT,
        authentication: {
          strategy: 'auth0',
          payload: {
            sub: 'auth0|currentValidTokenMember',
            aud: [
              'https://example.auth0.com/api/v2/',
              'https://example.auth0.com/userinfo'
            ],
            iss: 'https://example.auth0.com/'
          }
        },
        user: {
          _id: result.user._id,
          user_id: 'auth0|currentValidTokenMember'
        }
      }, 'The expected authenticate() result was not returned')
    })
  })

  describe('handleConnection() method', () => {
    it('is a function', () => {
      console.log(strategy.connection)
      assert(typeof strategy.handleConnection === 'function', 'authenticate() is not a function.')
    })

  })
})

describe('The Auth0Service', () => {
  let service

  before(() => {
    service = new Auth0Service(app)
    service.register('auth0', new MockAuth0Strategy())
    app.use('/authentication', service)
  })

  after(() => {

  })

  describe('setup() method', () => {
    it('is a function', () => {
      assert(typeof service.setup === 'function', 'setup() is not a function')
    })

    it('throws an error if auth0 domain is not set', async () => {
      try {
        const appWithUndefinedService = feathers()
        const undefinedService = new Auth0Service(appWithUndefinedService, 'authentication', {
          auth0: {
            domain: undefined,
            keysService: 'keys'
          },
          authStrategies: ['auth0'],
          entity: 'user',
          entityId: 'user_id',
          service: 'users',
          jwtOptions: {}
        })
        undefinedService.register('auth0', new MockAuth0Strategy())
        appWithUndefinedService.use('/authentication', undefinedService)
        appWithUndefinedService.setup()
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
        assert.strictEqual(
          err.message,
          'You must set `authentication.auth0.domain` in your app configuration.',
          'message should be \'You must set `authentication.auth0.domain` in your app configuration.\''
        )
      }
    })

    it('throws an error if service name is not set', async () => {
      try {
        const appWithUndefinedService = feathers()
        const undefinedService = new Auth0Service(appWithUndefinedService, 'authentication', {
          auth0: {
            domain: 'example.auth0.com',
            keysService: 'keys'
          },
          authStrategies: ['auth0'],
          entity: 'user',
          entityId: 'user_id',
          service: undefined,
          jwtOptions: {}
        })
        undefinedService.register('auth0', new MockAuth0Strategy())
        appWithUndefinedService.use('/authentication', undefinedService)
        appWithUndefinedService.setup()
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'Error', 'should throw an Error')
        assert.strictEqual(
          err.message,
          'The \'service\' option is not set in the authentication configuration',
          'message should be \'The \'service\' option is not set in the authentication configuration\''
        )
      }
    })

    it('throws an error if entity service does not exist', async () => {
      try {
        const appWithNoUsersService = feathers()
        const noUsersService = new Auth0Service(appWithNoUsersService, 'authentication', {
          auth0: {
            domain: 'example',
            keysService: 'keys'
          },
          authStrategies: ['auth0'],
          entity: 'user',
          entityId: 'user_id',
          service: 'users',
          jwtOptions: {}
        })
        noUsersService.register('auth0', new MockAuth0Strategy())
        appWithNoUsersService.use('/authentication', noUsersService)
        appWithNoUsersService.setup()
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'Error', 'should throw a Error')
        assert.strictEqual(
          err.message,
          'The \'users\' entity service does not exist (set to \'null\' if it is not required)',
          'message should be \'The \'users\' entity service does not exist (set to \'null\' if it is not required)\''
        )
      }
    })

    it('throws an error if entity service exists but has no id', async () => {
      try {
        const appWithNoUserID = feathers()
        const noUserIDService = new Auth0Service(appWithNoUserID, 'authentication', {
          auth0: {
            domain: 'example',
            keysService: 'keys'
          },
          authStrategies: ['auth0'],
          entity: 'user',
          entityId: undefined,
          service: 'users',
          jwtOptions: {}
        })
        noUserIDService.register('auth0', new MockAuth0Strategy())
        appWithNoUserID.use('/authentication', noUserIDService)
        appWithNoUserID.use('/users', {
          async find () { return [] }
        })
        appWithNoUserID.setup()
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'Error', 'should throw a Error')
        assert.strictEqual(
          err.message,
          'The \'users\' service does not have an \'id\' property and no \'entityId\' option is set.',
          'message should be \'The \'users\' service does not have an \'id\' property and no \'entityId\' option is set.\''
        )
      }
    })
  })

  describe('authenticate() hook', () => {
    let authenticateHook

    before(async () => {
      // add a Member
      await app.service('users').create({
        user_id: 'auth0|currentValidTokenMember'
      })
      authenticateHook = authenticate('auth0')
    })

    after(async () => {
      // remove the Member added in before()
      await app.service('users').remove(null, {
        query: {
          user_id: 'auth0|currentValidTokenMember'
        }
      })
    })

    it('is a function', () => {
      assert(typeof authenticateHook === 'function', 'authenticateHook() is not a function')
    })

    it('throws an error if not initialized with an auth strategy', () => {
      try {
        const authHook = authenticate() // eslint-disable-line no-unused-vars
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'Error', '\'err.name\' should be \'Error\'')
        assert.strictEqual(err.message, 'The authenticate hook needs at least one allowed strategy', 'Wrong message')
      }
    })

    it('throws an error if called from an after context', async () => {
      try {
        await authenticateHook(contexts.afterContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', '\'err.name\' should be \'NotAuthenticated\'')
        assert.strictEqual(
          err.message,
          'The authenticate hook must be used as a before hook',
          'wrong message'
        )
      }
    })
    
    it('throws an error if called from an error context', async () => {
      try {
        await authenticateHook(contexts.errorContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', '\'name\' should be \'NotAuthenticated\'')
        assert.strictEqual(
          err.message,
          'The authenticate hook must be used as a before hook',
          'wrong message'
        )
      }
    })
    
    it('throws an error if trying to authenticate the `/authentication` path', async () => {
      const authContext = {
        app,
        type: 'before',
        params: { provider: '' },
        service: app.service('/authentication')
      }
      try {
        await authenticateHook(authContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'The authenticate hook does not need to be used on the authentication service', 'wrong message')
      }
    })

    it('throws an error if no authentication info is sent', async () => {
      try {
        await authenticateHook(contexts.noAuthenticationContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Not authenticated', 'wrong message')
      }
    })

    it('simply returns the context if called from a server context, i.e. does not authenticate internal calls', async () => {
      const context = await authenticateHook(contexts.serverContext)
      assert.deepEqual(context, contexts.serverContext, 'Contexts did not match')
    })

    it('throws an error if the Authorization header is not set', async () => {
      try {
        await authenticateHook(contexts.noAuthorizationHeaderContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Token could not be verified', 'wrong message')
        assert.strictEqual(err.data.message, 'The access token was malformed or missing', 'wrong message')
      }
    })

    it('throws an error if the token is malformed or missing', async () => {
      try {
        await authenticateHook(contexts.malformedTokenContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Token could not be verified', 'wrong message')
        assert.strictEqual(err.data.message, 'The access token was malformed or missing', 'wrong message')
      }
    })

    it('throws an error if the user does not exist', async () => {
      try {
        await authenticateHook(contexts.unknownMemberContext)
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Could not find user with this user_id in the database', 'wrong message')
      }
    })

    it('returns the context if the user is already authenticated', async () => {
      const context = await authenticateHook(contexts.alreadyAuthenticatedContext)
      assert.deepEqual(context, contexts.alreadyAuthenticatedContext, 'the contexts were not the same')
    })

    /**
     * TODO: Do we need so many nested layers of error catching?
     */
    it('throws an error if the token cannot be verified', async () => {
      try {
        await authenticateHook(contexts.invalidIssuerMemberContext)
        assert.fail('Should never get here.')
      }
      catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Token could not be verified', 'wrong message')
        assert.strictEqual(err.data.message, 'jwt issuer invalid. expected: https://example.auth0.com/', 'wrong data')
      }
    })

    it('returns the context if the JWT is successfully verified', async () => {
      const context = await authenticateHook(contexts.currentValidTokenMemberContext)
      assert.deepEqual(context, contexts.currentValidTokenMemberContext, 'the contexts were not the same')
    })
  })

  describe('fromAuth0() hook', () => {
    let fromAuth0Hook
    let fromEuropeanAuth0Hook

    before(() => {
      fromAuth0Hook = fromAuth0()
      fromEuropeanAuth0Hook = fromAuth0({
        whitelist: [
          '52.28.56.226',
          '52.28.45.240',
          '52.16.224.164',
          '52.16.193.66',
          '34.253.4.94',
          '52.50.106.250',
          '52.211.56.181',
          '52.213.38.246',
          '52.213.74.69',
          '52.213.216.142',
          '35.156.51.163',
          '35.157.221.52',
          '52.28.184.187',
          '52.28.212.16',
          '52.29.176.99',
          '52.57.230.214',
          '54.76.184.103',
          '52.210.122.50',
          '52.208.95.174',
          '52.210.122.50',
          '52.208.95.174',
          '54.76.184.103'
        ]
      })
    })

    it('is a function', () => {
      assert(typeof fromAuth0Hook === 'function', 'fromAuth0() is not a function.')
    })
    
    it('returns true if the request context comes from a whitelisted IP address', async () => {
      const isWhitelisted = await fromAuth0Hook(contexts.fromAuth0Context)
      assert(isWhitelisted, 'an IP address on the whitelist was rejected')
    })
    
    it('returns true if the request context comes from a European whitelisted IP address', async () => {
      const isWhitelisted = await fromEuropeanAuth0Hook(contexts.fromEuropeanAuth0Context)
      assert(isWhitelisted, 'an IP address on the whitelist was rejected')
    })
    
    it('returns false if the request context comes from a non-whitelisted IP address', async () => {
      const isWhitelisted = await fromAuth0Hook(contexts.notFromAuth0Context)
      assert(!isWhitelisted, 'an IP address not on the whitelist was accepted')
    })

    it('can use whitelist overridden in config', async () => {
      const customConfig = Object.assign({}, config, {
        auth0: {
          domain: 'example.auth0.com',
          whitelist: ['66.66.66.66']
        }
      })
      app.set('authentication', customConfig)
      const isWhitelisted = await fromAuth0Hook(contexts.notFromAuth0Context)
      assert(isWhitelisted, 'The IP address whitelist was not correctly overridden')
    })
  })

  xit('registers authenticate() to run before all non-Auth0, external REST requests', async () => {
    ['find', 'get', 'create', 'update', 'patch', 'remove'].forEach(
      async hook => {
        let authenticateHook
        try {
          const hooks = app.service('users').__hooks.before[hook]
          // console.log(testApp.__hooks) // eslint-disable-line
          assert(Array.isArray(hooks), `No "${hook}" hooks are defined for the app`)
          assert(hooks.length > 0, `Wrong number of "${hook}" hooks defined for the app`)
          authenticateHook = hooks.pop()
          await authenticateHook(contexts.invalidIssuerMemberContext)
          assert.fail('Should never get here.')
        } catch (err) {
          assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        }
        try {
          const context = await authenticateHook(contexts.currentValidTokenMemberContext)
          assert.deepEqual(
            context,
            contexts.currentValidTokenMemberContext,
            `authorizeRest() "${hook}" returned the wrong result`
          )
        } catch (err) {
          // noop
        }
      }
    )          
  })

  describe('connection() hook', () => {

    it('returns the passed authentication params on create (login)', async () => {
      const connectionHook = connection('login')
      // console.log(service.handleConnection)
      contexts.createValidTokenConnectionContext.service = service
      const context = await connectionHook(contexts.createValidTokenConnectionContext)
      assert.deepEqual(context, contexts.createValidTokenConnectionContext, 'the contexts differ')
      connection('disconnect')(contexts.createValidTokenConnectionContext)
    })

    it('returns the passed authentication params on create (login) if there is no connection', async () => {
      const connectionHook = connection('login')
      const context = await connectionHook(contexts.noConnectionContext)
      assert.deepEqual(context, contexts.noConnectionContext, 'the contexts differ')
      connection('disconnect')(contexts.noConnectionContext)
    })

    it('removes the authentication info from the connection context on logout', async () => {
      const connectionHook = connection('logout')
      contexts.removeValidTokenConnectionContext.service = service
      const context = await connectionHook(contexts.removeValidTokenConnectionContext)
      assert.deepEqual(context, {
        app,
        type: 'after',
        method: 'remove',
        params: {
          connection: {
            strategy: 'auth0'
          },
          provider: 'socketio',
        },
        result: {
          accessToken: jwts.currentMemberJWT,
          strategy: 'auth0'
        },
        service
      }, 'the contexts do not match')
    })
    connection('disconnect')(contexts.removeValidTokenConnectionContext)
  })

  describe('events() hook', () => {
    it('emits the login event', done => {
      const eventHook = event('login')
      app.once('login', (result, params, context) => {
        try {
          assert.deepEqual(result, contexts.createValidTokenConnectionContext.result)
          assert.deepEqual(params, contexts.createValidTokenConnectionContext.params)
          assert.equal(context.method, 'create')
          done()
        } catch (err) {
          done(err)
        }
      })
      eventHook(contexts.createValidTokenConnectionContext)
    })

    it('emits the logout event', done => {
      const eventHook = event('logout')
      app.once('logout', (result, params, context) => {
        try {
          assert.deepEqual(result, contexts.removeValidTokenConnectionContext.result)
          assert.deepEqual(params, contexts.removeValidTokenConnectionContext.params)
          assert.equal(context.method, 'remove')
          done()
        } catch (err) {
          done(err)
        }
      })
      eventHook(contexts.removeValidTokenConnectionContext)
    })
  })
})
