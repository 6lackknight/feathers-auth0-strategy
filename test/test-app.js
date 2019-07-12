/**
 * Defines a minimal feathers app to use for running tests
 */
const feathers = require('@feathersjs/feathers')
const express = require('@feathersjs/express')
const nedb = require('nedb')
const createNeDBService = require('feathers-nedb')

// initialize a test app for testing utility functions
// that acts like auth0Setup() has already been run
const app = express(feathers())

// create the schema for users and register the users service
app.use('/users', createNeDBService({ Model: new nedb(), multi: true }))

module.exports = app