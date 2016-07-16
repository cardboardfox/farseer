import { EventEmitter } from 'events';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import extend from 'extend';

import findPlayerName from './find-player-name';
import newPlayerIds from './new-player-ids';
import handleZoneChanges from './handle-zone-changes';

var defaultOptions = {
  endOfLineChar: os.EOL
};

var debug = require('debug');
// Define some debug logging functions for easy and readable debug messages.
var log = {
  main: debug('HLW'),
  gameStart: debug('HLW:game-start'),
  zoneChange: debug('HLW:zone-change'),
  gameOver: debug('HLW:game-over')
};

// Determine the default location of the config and log files.
if (/^win/.test(os.platform())) {
  log.main('Windows platform detected.');
  var programFiles = 'Program Files';
  if (/64/.test(os.arch())) {
    programFiles += ' (x86)';
  }
  defaultOptions.logFile = path.join('C:', programFiles, 'Hearthstone', 'Hearthstone_Data', 'output_log.txt');
  defaultOptions.configFile = path.join(process.env.LOCALAPPDATA, 'Blizzard', 'Hearthstone', 'log.config');
} else {
  log.main('OS X platform detected.');
  defaultOptions.logFile = path.join(process.env.HOME, 'Library', 'Logs', 'Unity', 'Player.log');
  defaultOptions.configFile = path.join(process.env.HOME, 'Library', 'Preferences', 'Blizzard', 'Hearthstone', 'log.config');
}

// The watcher is an event emitter so we can emit events based on what we parse in the log.
function LogWatcher(options) {
    this.options = extend({}, defaultOptions, options);

    log.main('config file path: %s', this.options.configFile);
    log.main('log file path: %s', this.options.logFile);

    // Copy local config file to the correct location.
    // We're just gonna do this every time.
    var localConfigFile = path.join(__dirname, './log.config');
    fs.createReadStream(localConfigFile).pipe(fs.createWriteStream(this.options.configFile));
    log.main('Copied log.config file to force Hearthstone to write to its log file.');
}
util.inherits(LogWatcher, EventEmitter);

LogWatcher.prototype.start = function () {
  var self = this;

  var parserState = new ParserState;

  log.main('Log watcher started.');
  // Begin watching the Hearthstone log file.
  var fileSize = fs.statSync(self.options.logFile).size;
  fs.watchFile(self.options.logFile, function (current, previous) {
    if (current.mtime <= previous.mtime) { return; }

    // We're only going to read the portion of the file that we have not read so far.
    var newFileSize = fs.statSync(self.options.logFile).size;
    var sizeDiff = newFileSize - fileSize;
    if (sizeDiff < 0) {
      fileSize = 0;
      sizeDiff = newFileSize;
    }
    var buffer = new Buffer(sizeDiff);
    var fileDescriptor = fs.openSync(self.options.logFile, 'r');
    fs.readSync(fileDescriptor, buffer, 0, sizeDiff, fileSize);
    fs.closeSync(fileDescriptor);
    fileSize = newFileSize;

    self.parseBuffer(buffer, parserState);
  });

  self.stop = function () {
    fs.unwatchFile(self.options.logFile);
    delete self.stop;
  };
};

LogWatcher.prototype.stop = function () {};

LogWatcher.prototype.parseBuffer = function (buffer, parserState) {
  var self = this;

  if (!parserState) {
    parserState = new ParserState;
  }

  // Iterate over each line in the buffer.
  buffer.toString().split(this.options.endOfLineChar).forEach(function (line) {

    parserState = handleZoneChanges(line, parserState, self.emit, log);
    parserState.players = newPlayerIds(line, parserState.players);
    parserState.players = findPlayerName(line, parserState.players);

    // Check if the game is over.
    var gameOverRegex = /\[Power\] GameState\.DebugPrintPower\(\) - TAG_CHANGE Entity=(.*) tag=PLAYSTATE value=(LOST|WON|TIED)$/;
    if (gameOverRegex.test(line)) {
      var parts = gameOverRegex.exec(line);
      // Set the status for the appropriate player.
      parserState.players.forEach(function (player) {
        if (player.name === parts[1]) {
          player.status = parts[2];
        }
      });
      parserState.gameOverCount++;
      // When both players have lost, emit a game-over event.
      if (parserState.gameOverCount === 2) {
        log.gameOver('The current game has ended.');
        self.emit('game-over', parserState.players);
        parserState.reset();
      }
    }

  });
};

function ParserState() {
  this.reset();
}

ParserState.prototype.reset = function () {
  this.players = [];
  this.playerCount = 0;
  this.gameOverCount = 0;
};


// Set the entire module to our emitter.
module.exports = LogWatcher;
