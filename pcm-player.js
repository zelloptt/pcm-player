function PCMPlayer(options, onendedCallback) {
    const defaults = {
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 8000,
        flushingTime: 1000,
        gain: 1
    };
    this.options = Object.assign({}, defaults, options);
    if (this.options.gain !== undefined && !this.isValidGain(this.options.gain)) {
        this.options.gain = 1;
    }
    this.samples = new Float32Array([]);
    this.flush = this.flush.bind(this);
    this.startTimestampMs = Date.now();
    this.flushTimeSyncMs = this.options.flushingTime;
    this.flushTimer = setTimeout(this.flush, this.flushTimeSyncMs);
    this.maxValue = this.getMaxValue();
    this.typedArray = this.getTypedArray();
    this.onendedCallback = onendedCallback;
    this.feedCounter = 0;
}

PCMPlayer.prototype.init = function() {
    return this.createContext();
};

// https://hackernoon.com/unlocking-web-audio-the-smarter-way-8858218c0e09
PCMPlayer.prototype.webAudioTouchUnlock = function (context) {
    return new Promise(function (resolve, reject) {
        if (context.state === 'suspended' && 'ontouchstart' in window) {
            var unlock = function() {
                context.resume().then(function() {
                      document.body.removeEventListener('touchstart', unlock);
                      document.body.removeEventListener('touchend', unlock);
                      resolve(true);
                  },
                  function (reason) {
                      reject(reason);
                  });
            };
            document.body.addEventListener('touchstart', unlock, false);
            document.body.addEventListener('touchend', unlock, false);
        }
        else {
            resolve(false);
        }
    });
};

PCMPlayer.prototype.isValidGain = function (gain) {
    return isFinite(gain) && gain <= 2 && gain >= 0;
};

PCMPlayer.prototype.getMaxValue = function () {
    const encodings = {
        '8bitInt': 128,
        '16bitInt': 32768,
        '32bitInt': 2147483648,
        '32bitFloat': 1
    };

    return encodings[this.options.encoding] ? encodings[this.options.encoding] : encodings['16bitInt'];
};

PCMPlayer.prototype.getTypedArray = function () {
    const typedArrays = {
        '8bitInt': Int8Array,
        '16bitInt': Int16Array,
        '32bitInt': Int32Array,
        '32bitFloat': Float32Array
    };

    return typedArrays[this.options.encoding] ? typedArrays[this.options.encoding] : typedArrays['16bitInt'];
};

PCMPlayer.prototype.createContext = function() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return this.webAudioTouchUnlock(this.audioCtx).then(function () {
        if (!this.audioCtx) {
            return;
        }
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.options.gain;
        this.options.useAudioElement
        ? this.createAudioElement()
        : this.gainNode.connect(this.audioCtx.destination);
        this.startTime = this.audioCtx.currentTime;
    }.bind(this));
};

PCMPlayer.prototype.createAudioElement = function() {
    const destination = this.audioCtx.createMediaStreamDestination();
    this.gainNode.connect(destination);
    this.audioEl = new Audio();
    this.audioEl.srcObject = destination.stream;
    this.startTime = this.audioCtx.currentTime;
    if (this.options.outputDeviceId) {
        this.audioEl.setSinkId(this.options.outputDeviceId);
    }
    this.audioEl.play(); 
}

PCMPlayer.prototype.isTypedArray = function(data) {
    return (data.byteLength && data.buffer && data.buffer.constructor === ArrayBuffer);
};

PCMPlayer.prototype.feed = function(data) {
    if (this.muted) {
        return;
    }
    if (!this.isTypedArray(data)) return;

    data = this.getFormattedValue(data);
    const tmp = new Float32Array(this.samples.length + data.length);
    tmp.set(this.samples, 0);
    tmp.set(data, this.samples.length);
    this.samples = tmp;
    this.feedCounter++;
};

PCMPlayer.prototype.getFormattedValue = function(data) {
    const typedData = new this.typedArray(data.buffer);
    const float32Data = new Float32Array(typedData.length);
    for (let i = 0; i < typedData.length; i++) {
        float32Data[i] = typedData[i] / this.maxValue;
    }
    return float32Data;
};

/**
 * Sets the gain for the player.
 * @param gain Desired playback gain. Expected range is [0, 2]
 */
PCMPlayer.prototype.setGain = function(gain) {
    if (!this.isValidGain(gain)) {
        return false;
    }
    this.options.gain = gain;
    this.gainNode.gain.value = gain;
};

PCMPlayer.prototype.setSinkId = function(deviceId) {
    if (this.audioEl) {
        this.audioEl.setSinkId(deviceId);
    }
}

PCMPlayer.prototype.reset = function() {
    this.samples = new Float32Array([]);
    this.feedCounter = 0;

    if (this.bufferSource) {
        this.bufferSource.stop();
    }
};

PCMPlayer.prototype.destroy = function() {
    this.reset();

    if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
    }
    this.flushTimeSyncMs = 0;
    this.startTimestampMs = 0;

    this.audioCtx.close();
    this.audioCtx = null;
};

PCMPlayer.prototype.flush = function() {
    this.flushTimeSyncMs += this.options.flushingTime;
    let elapsedMs = Date.now() - this.startTimestampMs;
    let delayMs = this.flushTimeSyncMs - elapsedMs;
    if (delayMs < 0 || delayMs > (this.options.flushingTime * 2)) {
        delayMs = this.options.flushingTime
    }
    this.flushTimer = setTimeout(this.flush, delayMs);

    if (!this.samples.length) return;
    let bufferSource = this.audioCtx.createBufferSource(),
      length = this.samples.length / this.options.channels,
      audioBuffer = this.audioCtx.createBuffer(this.options.channels, length, this.options.sampleRate),
      audioData,
      channel,
      offset,
      i,
      decrement;

    for (channel = 0; channel < this.options.channels; channel++) {
        audioData = audioBuffer.getChannelData(channel);
        offset = channel;
        decrement = 50;
        for (i = 0; i < length; i++) {
            audioData[i] = this.samples[offset];
            /* fadein */
            if (i < 50) {
                audioData[i] =  (audioData[i] * i) / 50;
            }
            /* fadeout*/
            if (i >= (length - 51)) {
                audioData[i] =  (audioData[i] * decrement--) / 50;
            }
            offset += this.options.channels;
        }
    }

    if (this.startTime < this.audioCtx.currentTime) {
        this.startTime = this.audioCtx.currentTime;
    }
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(this.gainNode);
    bufferSource.start(this.startTime);

    this.bufferSource = bufferSource;

    const feedCounter = this.feedCounter;
    const onendedCallback = this.onendedCallback;
    if (onendedCallback) {
        bufferSource.onended = () => onendedCallback(feedCounter);
    }
    this.startTime += audioBuffer.duration;
    this.samples = new Float32Array([]);
    this.feedCounter = 0;
};

PCMPlayer.prototype.mute = function(mute) {
    this.muted = mute;
};

PCMPlayer.prototype.setSampleRate = function(sampleRate) {
    this.options.sampleRate = sampleRate;
};

module.exports = PCMPlayer;
