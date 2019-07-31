const assert = require('assert')
const feathers = require('@feathersjs/feathers')
const Auth0Strategy = require('../lib/strategy')
const Auth0Service = require('../lib/service')
const { authenticate, hooks } = require('@feathersjs/authentication')
const fromAuth0 = require('../lib/hooks/from-auth0')
const { connection, events } = hooks
const {
  app,
  appUri,
  fakeJWKS,
  signingCertificate,
  jwts,
  contexts
} = require('./test-vars')

// extend Auth0Strategy so we can override getJWKS with a mock
class MockAuth0Strategy extends Auth0Strategy {
  getJWKS (uri) {
    return () => {
      if (uri === appUri) return Promise.resolve(fakeJWKS)
      if (uri === 'noMatchingKeysURI') {
        const copyOfFakeJWKS = JSON.parse(JSON.stringify(fakeJWKS))
        copyOfFakeJWKS.keys[0].kid = 'nonMatchingKid'
        return Promise.resolve(copyOfFakeJWKS)
      }
      throw 'The URI for the JWKS was incorrect'
    }
  }
}

const config = {
  auth0: {
    domain: 'example',
    keysService: 'keys'
  },
  authStrategies: ['auth0'],
  entity: 'user',
  entityId: 'user_id',
  service: 'users',
  jwtOptions: {}
}

describe('The Auth0Strategy', () => {
  let strategy

  before(() => {
    app.set('authentication', config)
    strategy = new MockAuth0Strategy()
    strategy.setName('auth0')
    const service = new Auth0Service(app)
    strategy.setApplication(app)
    strategy.setAuthentication(service)
  })

  it('is configured properly', () => {
    const configuration = Object.assign({}, config, {
      create: false,
      domain: 'example',
      header: 'Authorization',
      keysService: 'keys',
      schemes: [ 'Bearer', 'JWT' ]
    })
    delete configuration.auth0
    delete configuration.authStrategies
    delete configuration.jwtOptions
    assert.deepEqual(strategy.configuration, configuration, 'The strategy produces the wrong configuration')

    try {
      // unset the domain
      const noDomainConfig = Object.assign({}, config, { auth0: { domain: null } })
      strategy.app.set('authentication', noDomainConfig)
      strategy.verifyConfiguration()
      assert.fail('Should never get here')
    } catch (err) {
      assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
      assert.strictEqual(err.message, 'The \'authentication.auth0.domain\' option must be set.', 'Did not have the correct error message')
    }
    try {
      // create a config with a random key/value pair
      const randomConfig = Object.assign({}, config, {
        auth0: {
          domain: 'example',
          someRandomKey: 'someRandomValue'
        }
      })
      strategy.app.set('authentication', randomConfig)
      strategy.verifyConfiguration()
      assert.fail('Should never get here')
    } catch (err) {
      assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
      assert.strictEqual(
        err.message,
        'Invalid Auth0Strategy option \'authentication.auth0.someRandomKey\'',
        'Did not have the correct error message'
      )
    }
    // restore the valid app config
    strategy.app.set('authentication', config)
  })

  it('has a keys service', () => {
    assert(!!strategy.keysService, 'The keysService is undefined')
  })

  describe('getEntity() method', () => {
    it('is a function', () => {
      assert(typeof strategy.getEntity === 'function', 'getEntity() is not a function')
    })

    it('throws an error if no entity service is specified', async () => {
      const configuration = Object.assign({}, config)
      delete configuration.service
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
          domain: 'example',
          keysService: 'keys'
        },
        authStrategies: ['auth0'],
        createIfNotExists: true,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        jwtOptions: {}
      })
      const user = await strategy.getEntity('auth0|iDoNotExist', {})
      assert.strictEqual(user.user_id, 'auth0|iDoNotExist', 'The user was not created')
    })
  })

  describe('getJWKS() method', () => {
    it('is a function', () => {
      assert(typeof strategy.getJWKS === 'function', 'getJWKS() is not a function')
    })

    it('returns a function when passed a uri (string)', () => {
      assert(
        typeof strategy.getJWKS(appUri) === 'function',
        'Calling getJWKS() with a valid URI parameter did not return a function'
      )
    })

    it('returns a JWKS asynchronously', async () => {
      const client = strategy.getJWKS(appUri)
      const jwks = await client()
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
        assert.strictEqual(err.message, 'Stored JWK has no x5c property.', 'message should be \'Stored JWK has no x5c property.\'')
      }
    })
  })

  describe('getKey() method', () => {
    it('is a function', () => {
      assert(typeof strategy.getKey === 'function', 'getKey() is not a function.')
    })

    it('returns a signing key in PEM format', async () => {
      const key = await strategy.getKey('goodKid', strategy.getJWKS(appUri))
      assert(key === signingCertificate, 'getKey() did not return the key expected')
    })

    it('throws an error if key is not already in memory and the jwksClient gets a bad URI', async () => {
      try {
        await strategy.getKey('badKid', strategy.getJWKS('badURI'))
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.data, 'The URI for the JWKS was incorrect', 'should let us know the JWKS URI was wrong')
        assert.strictEqual(err.message, 'Could not retrieve JWKS', 'message should be \'Could not retrieve JWKS\'')
      }
    })

    it('throws an error if key is not already in memory and the retrieved JWKS does not contain `kid`', async () => {
      try {
        await strategy.getKey('badKid', strategy.getJWKS('noMatchingKeysURI'))
        assert.fail('Should never get here')
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'Could not find a JWK matching given kid', 'message should be \'Could not find a JWK matching given kid\'')
      }
    })

    it('will return a stored key if found in the database', async () => {
      await app.service('keys').create(fakeJWKS.keys[0])
      const key = await strategy.getKey('goodKid', strategy.getJWKS(appUri))
      assert(key === signingCertificate, 'getKey() did not return the key expected')
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
        assert.strictEqual(err.message, 'No access token was received', 'message should be \'No access token was received\'')
      }
    })

    it('throws an error if the accessToken is malformed', async () => {
      try {
        await strategy.authenticate({ accessToken: 'a_bad_token' }, {})
      } catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should throw a NotAuthenticated')
        assert.strictEqual(err.message, 'The access token was malformed', 'message should be \'The access token was malformed\'')
      }
    })

    it('throws an error if the accessToken cannot be verified', async () => {
      try {
        await strategy.keysService.create(fakeJWKS.keys[0])
        await strategy.entityService.create({
          user_id: 'auth0|currentValidTokenMember'
        })
        await strategy.authenticate({ accessToken: jwts.invalidIssuerJWT }, {})
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
})

describe('The Auth0Service', () => {
  let service

  before(() => {
    app.set('authentication', config)
    service = new Auth0Service(app)
    service.register('auth0', new MockAuth0Strategy())
    app.use('/authentication', service)
    // initialize the service
    app.setup()
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
          'The \'authentication.auth0.domain\' option must be set.',
          'message should be \'The \'authentication.auth0.domain\' option must be set.\''
        )
      }
    })

    it('throws an error if service name is not set', async () => {
      try {
        const appWithUndefinedService = feathers()
        const undefinedService = new Auth0Service(appWithUndefinedService, 'authentication', {
          auth0: {
            domain: 'example',
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
        assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
        assert.strictEqual(
          err.message,
          'Since the \'entity\' option is set to \'user\', the \'service\' option must also be set',
          'message should be \'Since the \'entity\' option is set to \'user\', the \'service\' option must also be set\''
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
        assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
        assert.strictEqual(
          err.message,
          'The \'users\' entity service does not exist. Set to \'null\' if it is not required.',
          'message should be \'The \'users\' entity service does not exist. Set to \'null\' if it is not required.\''
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
        assert.strictEqual(err.name, 'GeneralError', 'should throw a GeneralError')
        assert.strictEqual(
          err.message,
          'The \'users\' service does not have an \'id\' property and no \'entityId\' option is set',
          'message should be \'The \'users\' service does not have an \'id\' property and no \'entityId\' option is set\''
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
      }
      catch (err) {
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
      }
      catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'The authenticate hook does not need to be used on the authentication service', 'wrong message')
      }
    })

    it('throws an error if no authentication info is sent', async () => {
      try {
        await authenticateHook(contexts.noAuthenticationContext)
        assert.fail('Should never get here')
      }
      catch (err) {
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
      }
      catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'No access token was received', 'wrong message')
      }
    })

    it('throws an error if the token is malformed or missing', async () => {
      try {
        await authenticateHook(contexts.malformedTokenContext)
        assert.fail('Should never get here')
      }
      catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'The access token was malformed', 'wrong message')
      }
    })

    it('throws an error if the user does not exist', async () => {
      try {
        await authenticateHook(contexts.unknownMemberContext)
        assert.fail('Should never get here')
      }
      catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Could not find user with this user_id in the database', 'wrong message')
      }
    })

    it('returns the context if the user is already authenticated', async () => {
      const context = await authenticateHook(contexts.alreadyAuthenticatedContext)
      assert.deepEqual(context, contexts.alreadyAuthenticatedContext, 'the contexts were not the same')
    })

    it('throws an error if the token cannot be verified', async () => {
      try {
        await authenticateHook(contexts.invalidIssuerMemberContext)
        assert.fail('Should never get here.')
      }
      catch (err) {
        assert.strictEqual(err.name, 'NotAuthenticated', 'should be \'NotAuthenticated\'')
        assert.strictEqual(err.message, 'Token could not be verified', 'wrong message')
        assert.strictEqual(err.data, 'jwt issuer invalid. expected: https://example.auth0.com/', 'wrong data')
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
      const customConfig = Object.assign({}, config)
      customConfig.auth0.whitelist = ['66.66.66.66']
      app.set('authentication', customConfig)
      const isWhitelisted = await fromAuth0Hook(contexts.notFromAuth0Context)
      assert(isWhitelisted, 'The IP address whitelist was not correctly overridden')
    })
  })

  it('prevents external requests from accessing the `keys` service', async () => {
    const keysHooks = app.service('keys').__hooks.before
    const externalContext = contexts.currentValidTokenMemberContext
    const serverContext = contexts.serverContext;
    ['find', 'get', 'create', 'update', 'patch', 'remove'].forEach(
      hook => {
        assert(Array.isArray(keysHooks[hook]), `No "${hook}" hooks are defined`)
        assert(keysHooks[hook].length, 1, `Wrong number of "${hook}" hooks defined`)
        const disallow = keysHooks[hook][0]
        assert(typeof disallow === 'function', '`disallow()` is not a function')
        externalContext.method = hook
        serverContext.method = hook
        assert.throws(() => { disallow(externalContext) }, `"${hook}" hook doesn't throw for external context`)
        assert.strictEqual(disallow(serverContext), serverContext, `Disallow "${hook}" returned the wrong result`)
      }
    )
  })

  it('registers authenticate() to run before all non-Auth0, external REST requests', () => {
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
    let connectionHook
    before(() => {
      connectionHook = connection()
    })

    it('is a function', () => {
      assert(typeof connectionHook === 'function', '`connectionHook()` should be a function')
    })

    it('returns the passed authentication params on create (login)', async () => {
      const context = connectionHook(contexts.createValidTokenConnectionContext)
      assert.deepEqual(context, contexts.createValidTokenConnectionContext, 'the contexts differ')
    })

    it('returns the passed authentication params on create (login) if there is no connection', async () => {
      const context = connectionHook(contexts.noConnectionContext)
      assert.deepEqual(context, contexts.noConnectionContext, 'the contexts differ')
    })

    it('removes the authentication info from the connection context on logout', () => {
      const context = connectionHook(contexts.removeValidTokenConnectionContext)
      assert.deepEqual(context, {
        app,
        type: 'after',
        method: 'remove',
        params: {
          connection: {},
          provider: 'socketio',
        },
        result: {
          accessToken: jwts.currentMemberJWT,
          strategy: 'auth0'
        }
      }, 'the contexts do not match')
    })
  })

  describe('events() hook', () => {
    let eventsHook
    before(() => {
      eventsHook = events()
    })

    it('emits the login event', done => {
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
      eventsHook(contexts.createValidTokenConnectionContext)
    })

    it('emits the logout event', done => {
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
      eventsHook(contexts.removeValidTokenConnectionContext)
    })
  })
})

describe('The addIP middleware', () => {
  it('should be registered', () => {
    assert(
      app._router && app._router.stack && app._router.stack.some(mw => mw.name === 'addIP'), 
      'the addIP middleware was not registered'
    )
  })

  it('should add the IP address to the req.feathers object', done => {
    // get the addIP function from the registered middleware
    const addIP = app._router.stack.find(mw => mw.name === 'addIP').handle
    const req = { feathers: {}, ip: '111.111.111.111', headers: {} }
    addIP(req, null, () => {
      assert(req.feathers.ip === '111.111.111.111', 'the IP address was not set correctly')
      done()
    })
  })

  it('should get the IP address from the x-real-ip header', done => {
    // get the addIP function from the registered middleware
    const addIP = app._router.stack.find(mw => mw.name === 'addIP').handle
    const req = { feathers: {}, headers: { 'x-real-ip': '111.111.111.111'} }
    addIP(req, null, () => {
      assert(req.feathers.ip === '111.111.111.111', 'the IP address was not set correctly')
      done()
    })
  })
})
