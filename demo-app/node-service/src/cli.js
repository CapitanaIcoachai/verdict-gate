'use strict';
const program = require('commander');
const chalk = require('chalk');
const glob = require('glob');
const rimraf = require('rimraf');
const fetch = require('node-fetch');
const uuidv4 = require('uuid/v4');
const _ = require('lodash');
const axios = require('axios');

program
  .version('1.0.0')
  .option('-d, --dir <dir>', 'source directory', '.')
  .parse(process.argv);

function cleanBuild(dir, done) {
  rimraf(dir + '/build', done);
}

function listSources(dir) {
  return glob.sync(dir + '/**/*.js', { ignore: '**/node_modules/**' });
}

function listAsync(dir, cb) {
  glob(dir + '/**/*.js', cb);
}

async function ping(url) {
  const res = await fetch(url);
  return res.json();
}

const runId = uuidv4();
console.log(chalk.green.bold('ready'), chalk.red('run ' + runId));

const slowSearch = _.debounce((q) => axios.get('/search', { params: { q } }), 300);

module.exports = { cleanBuild, listSources, listAsync, ping, slowSearch };
