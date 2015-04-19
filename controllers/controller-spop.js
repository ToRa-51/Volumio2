var libQ = require('kew');
var libNet = require('net');
var libFast = require('fast.js');

// Define the ControllerSpop class
module.exports = ControllerSpop;
function ControllerSpop (nHost, nPort, commandRouter) {

	// This fixed variable will let us refer to 'this' object at deeper scopes
	var _this = this;

	// Save a reference to the parent commandRouter
	this.commandRouter = commandRouter;

	// Each core gets its own set of Spop sockets connected
	this.connSpopCommand = libNet.createConnection(nPort, nHost); // Socket to send commands and receive track listings
	this.connSpopStatus = libNet.createConnection(nPort, nHost); // Socket to listen for status changes

	// Init some command socket variables
	this.bSpopCommandGotFirstMessage = false;

	this.spopCommandReadyDeferred = libQ.defer(); // Make a promise for when the Spop connection is ready to receive events (basically when it emits 'spop 0.0.1').
	this.spopCommandReady = this.spopCommandReadyDeferred.promise;

	this.spopResponseDeferred = libQ.defer();
	this.spopResponse = this.spopResponseDeferred.promise;
	this.sResponseBuffer = '';

	// Start a listener for command socket messages (command responses)
	this.connSpopCommand.on('data', function (data) {
		_this.sResponseBuffer = _this.sResponseBuffer.concat(data.toString());

		// If the last character in the data chunk is a newline, this is the end of the response
		if (data.slice(data.length - 1).toString() === '\n') {

			// If this is the first message, then the connection is open
			if (!_this.bSpopCommandGotFirstMessage) {
				_this.bSpopCommandGotFirstMessage = true;

				try {
					_this.spopCommandReadyDeferred.resolve();

				} catch (error) {
					_this.pushError(error);

				}

			// Else this is a command response
			} else {
				try {
					_this.spopResponseDeferred.resolve(_this.sResponseBuffer);

				} catch (error) {
					_this.pushError(error);

				}

			}

			// Reset the response buffer
			_this.sResponseBuffer = '';

		}

	});

	// Init some status socket variables
	this.bSpopStatusGotFirstMessage = false;
	this.sStatusBuffer = '';

	// Start a listener for status socket messages
	this.connSpopStatus.on('data', function (data) {
		_this.sStatusBuffer = _this.sStatusBuffer.concat(data.toString());

		// If the last character in the data chunk is a newline, this is the end of the status update
		if (data.slice(data.length - 1).toString() === '\n') {

			// Put socket back into monitoring mode
			_this.connSpopStatus.write('idle\n');

			// If this is the first message, then the connection is open
			if (!_this.bSpopStatusGotFirstMessage) {
				_this.bSpopStatusGotFirstMessage = true;

			// Else this is a state update announcement
			} else {
				var timeStart = Date.now(); 
				var sStatus = _this.sStatusBuffer;

				logStart('Spop announces state update')
					.then(function () {
						return _this.parseState.call(_this, sStatus);

					})
					.then(libFast.bind(_this.pushState, _this))
					.fail(libFast.bind(_this.pushError, _this))
					.done(function () {
						return logDone(timeStart);

					});

			}

			// Reset the status buffer
			_this.sStatusBuffer = '';

		}

	});

	this.library = new Object();

	this.libraryReady = 
		this.sendSpopCommand('ls', [])
		//.then(this.parseTracksInPlaylist)
		.fail(console.log);

}

// Public Methods ---------------------------------------------------------------------------------------
// These are 'this' aware, and return a promise

// Define a method to clear, add, and play an array of tracks
ControllerSpop.prototype.clearAddPlayTracks = function (arrayTrackIds) {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::clearAddPlayTracks');
	var _this = this;

	// From the array of track IDs, get array of track URIs to play
	var arrayTrackUris = libFast.map(arrayTrackIds, convertTrackIdToUri);

	// Clear the queue, add the first track, and start playback
	var firstTrack = arrayTrackUris.shift();
	var promisedActions = this.sendSpopCommand('uplay', [firstTrack]);

	// If there are more tracks in the array, add those also
	if (arrayTrackUris.length > 0) {
		promisedActions = libFast.reduce(arrayTrackUris, function (previousPromise, curTrackUri) {
			return previousPromise
				.then(function () {
					return _this.sendSpopCommand('uadd', [curTrackUri]);

				});

		}, promisedActions);

	}

	return promisedActions;

}

// Spop stop
ControllerSpop.prototype.stop = function () {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::stop');

	return this.sendSpopCommand('stop', []);

}

// Spop pause
ControllerSpop.prototype.pause = function () {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::pause');

	// TODO don't send 'toggle' if already paused
	return this.sendSpopCommand('toggle', []);

}

// Spop resume
ControllerSpop.prototype.resume = function () {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::resume');

	// TODO don't send 'toggle' if already playing
	return this.sendSpopCommand('toggle', []);

}

// Spop music library
ControllerSpop.prototype.getLibrary = function () {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::getLibrary');
	var _this = this;

	return this.libraryReady
		.then(function () {
			return libQ.fcall(libFast.map, Object.keys(_this.library), function (currentKey) {
				return _this.library[currentKey];

			});

		});

}

// Internal methods ---------------------------------------------------------------------------
// These are 'this' aware, and may or may not return a promise

// Send command to Spop
ControllerSpop.prototype.sendSpopCommand = function (sCommand, arrayParameters) {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::sendSpopCommand');
	var _this = this;

	// Convert the array of parameters to a string
	var sParameters = libFast.reduce(arrayParameters, function (sCollected, sCurrent) {
		return sCollected + ' ' + sCurrent;

	},'');

	// Pass the command to Spop when the command socket is ready
	this.spopCommandReady
		.then(function () {
			return libQ.nfcall(libFast.bind(_this.connSpopCommand.write, _this.connSpopCommand), sCommand + sParameters + '\n', "utf-8");

		});

	// Return the command response
	return this.spopResponse
		.then(function (sResponse) {

			// Reset the response promise so it can be reused for future commands
			_this.spopResponseDeferred = libQ.defer();

			return sResponse;

		})
		.fail(libFast.bind(_this.pushError, _this));

}

// Spop get state
ControllerSpop.prototype.getState = function () {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::getState');

	return this.sendSpopCommand('status', []);

}

// Spop parse state
ControllerSpop.prototype.parseState = function (sState) {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::parseState');
	var objState = JSON.parse(sState);

	var nSeek = null;
	if ('position' in objState) {
		nSeek = objState.position * 1000;

	}

	var nDuration = null;
	if ('duration' in objState) {
		nDuration = objState.duration;

	}

	var sStatus = null;
	if ('status' in objState) {
		if (objState.status === 'playing') {
			sStatus = 'play';

		} else if (objState.status === 'paused') {
			sStatus = 'pause';

		} else if (objState.status === 'stopped') {
			sStatus = 'stop';

		}

	}

	var nPosition = null;
	if ('current_track' in objState) {
		nPosition = objState.current_track - 1;

	}

	return libQ.resolve({
		status: sStatus,
		position: nPosition,
		seek: nSeek,
		duration: nDuration,
		samplerate: null, // Pull these values from somwhere else since they are not provided in the Spop state
		bitdepth: null,
		channels: null

	});

}

// Announce updated Spop state
ControllerSpop.prototype.pushState = function (state) {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::pushState');

	return this.commandRouter.spopPushState(state);

}

// Pass the error if we don't want to handle it
ControllerSpop.prototype.pushError = function (sReason) {

	console.log('[' + Date.now() + '] ' + 'ControllerSpop::pushError');
	console.log(sReason);

	// Return a resolved empty promise to represent completion
	return libQ.resolve();

}

// Parse tracks in playlists
ControllerSpop.prototype.parseTracksInPlaylists = function (sInput) {

	var objInput = JSON.parse(sInput);

	return objInput;

}

// Internal helper functions --------------------------------------------------------------------------
// These are static, and not 'this' aware

// Helper function to convert trackId to URI
function convertTrackIdToUri (input) {

	// Convert base64->utf8
	return (new Buffer(input, 'base64')).toString('utf8');

}

// Helper function to convert URI to trackId
function convertUriToTrackId (input) {

	// Convert utf8->base64
	return (new Buffer(input, 'utf8')).toString('base64');

}

function logDone (timeStart) {

	console.log('[' + Date.now() + '] ' + '------------------------------ ' + (Date.now() - timeStart) + 'ms');
	return libQ.resolve();

}

function logStart (sCommand) {

	console.log('\n' + '[' + Date.now() + '] ' + '---------------------------- ' + sCommand);
	return libQ.resolve();

}
