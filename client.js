console.time("connecting");
console.time("loading");

// Initialize global state
let lastPrompt = null;
let lastSeed = null;
let lastSent = null;
let sending = false;
let waiting = false;
let dataChannel = null;
let dataChannelOpen = false;
let pc = null;
let timeStart = null;

// Cached DOM elements
const promptInput = document.getElementById("prompt");
const seedInput = document.getElementById("seed");
const dataChannelLog = document.getElementById("data-channel");
const iceConnectionLog = document.getElementById("ice-connection-state");
const iceGatheringLog = document.getElementById("ice-gathering-state");
const signalingLog = document.getElementById("signaling-state");

// Utility function to wait for a specified amount of time
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to get prompt data
async function getPrompt() {
  while (true) {
    if (promptInput && promptInput.value) {
      const newPrompt = promptInput.value;
      const newSeed = seedInput.value;
      if (newPrompt !== lastPrompt || newSeed !== lastSeed) {
        lastPrompt = newPrompt;
        lastSeed = newSeed;
        lastSent = Date.now();
        console.time("generation");
        return JSON.stringify({ prompt: newPrompt, seed: newSeed });
      }
    }
    await wait(100);
  }
}

// Function to handle incoming image data
function handleImage(data) {
  waiting = false;
  const parsed = { image: data };
  const topImage = document.getElementById("imoge");
  const bottomImage = document.getElementById("imoge2");
  const newOpacity = topImage.style.opacity === "1" ? "0" : "1";
  topImage.style.opacity = newOpacity;
  bottomImage.style.opacity = newOpacity === "1" ? "0" : "1";
  (newOpacity === "1" ? topImage : bottomImage).src = parsed.image;
  sendPrompt();
}

// Function to send prompt over WebRTC data channel or WebSocket
function sendPrompt() {
  if (waiting) {
    return;
  }
  waiting = true;
  getPrompt().then((prompt) => {
    const trySend = () => {
      if (dataChannel && dataChannelOpen) {
        dataChannelLog.textContent += "> " + prompt + "\n";
        dataChannel.send(prompt);
        sending = false;
      } else {
        console.log("No connections open, retrying");
      }
    };
    const interval = setInterval(() => {
      if (!sending) {
        trySend();
        clearInterval(interval);
      }
    }, 1000);
  });
}

// Utility functions
function timeStamp() {
  if (!timeStart) {
    timeStart = Date.now();
    return 0;
  } else {
    return Date.now() - timeStart;
  }
}
function make_elapsed() {
  let last = Date.now();
  return () => {
    const now = Date.now();
    const elapsed = `${Math.round((now - last) / 100) / 10}s`;
    last = now;
    return elapsed;
  };
}

// Peer connection setup
function createPeerConnection() {
  const config = {
    sdpSemantics: "unified-plan",
  };

  gather_elapsed = make_elapsed();
  connection_elapsed = make_elapsed();
  signaling_elapsed = make_elapsed();

  if (document.getElementById("use-stun").checked) {
    config.iceServers = [
      { urls: "stun:stun.relay.metered.ca:80" },
      {
        urls: "turn:a.relay.metered.ca:80",
        username: "d0d9c8df0b9e209b5f81f70d",
        credential: "32ANR/GokUdBpWrp",
      },
      {
        urls: "turn:a.relay.metered.ca:80?transport=tcp",
        username: "d0d9c8df0b9e209b5f81f70d",
        credential: "32ANR/GokUdBpWrp",
      },
      {
        urls: "turn:a.relay.metered.ca:443",
        username: "d0d9c8df0b9e209b5f81f70d",
        credential: "32ANR/GokUdBpWrp",
      },
      {
        urls: "turn:a.relay.metered.ca:443?transport=tcp",
        username: "d0d9c8df0b9e209b5f81f70d",
        credential: "32ANR/GokUdBpWrp",
      },
    ];
  }

  pc = new RTCPeerConnection(config);

  // Event listeners for debugging
  pc.addEventListener(
    "icegatheringstatechange",
    () => {
      iceGatheringLog.textContent += ` -(${gather_elapsed()})-> ${
        pc.iceGatheringState
      }`;
    },
    false,
  );
  pc.addEventListener(
    "iceconnectionstatechange",
    () => {
      iceConnectionLog.textContent += ` -(${connection_elapsed()})-> ${
        pc.iceConnectionState
      }`;
    },
    false,
  );
  pc.addEventListener(
    "signalingstatechange",
    () => {
      signalingLog.textContent += ` -(${signaling_elapsed()})-> ${
        pc.signalingState
      }`;
    },
    false,
  );

  return pc;
}

// Negotiation of the WebRTC connection
async function negotiate() {
  try {
    console.time("create offer");
    const offer = await pc.createOffer();
    console.timeEnd("create offer");
    console.time("setLocalDescription");
    await pc.setLocalDescription(offer);
    console.timeEnd("setLocalDescription");
    console.time("ice gathering");

    // Wait for ICE gathering to complete
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
      } else {
        const checkState = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", checkState);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", checkState);
      }
    });
    console.timeEnd("ice gathering");

    const offerSDP = pc.localDescription;
    document.getElementById("offer-sdp").textContent = offerSDP.sdp;
    console.time("fetch offer");
    const response = await fetch("/offer", {
      body: JSON.stringify({
        sdp: offerSDP.sdp,
        type: offerSDP.type,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    console.timeEnd("fetch offer");

    const answer = await response.json();
    document.getElementById("answer-sdp").textContent = answer.sdp;
    console.time("setRemoteDescription");
    await pc.setRemoteDescription(answer);
    console.timeEnd("setRemoteDescription");
  } catch (e) {
    console.error(e);
    alert(e);
  }
}

// Start the WebRTC connection
async function start() {
  pc = createPeerConnection();
  console.time("create data channel");
  dataChannel = pc.createDataChannel("chat", { ordered: true });
  console.timeEnd("create data channel");
  // Setup the data channel event handlers
  dataChannel.onclose = () => {
    dataChannelOpen = false;
    clearInterval(dcInterval);
    dataChannelLog.textContent += "- close\n";
  };
  dataChannel.onopen = () => {
    dataChannelOpen = true;
    dataChannelLog.textContent += "- open\n";
    dcInterval = setInterval(() => {
      const message = `ping ${timeStamp()}`;
      dataChannelLog.textContent += `> ${message}\n`;
      dataChannel.send(message);
    }, 1000);
    sendPrompt();
    console.timeEnd("connecting");
  };
  dataChannel.onmessage = (evt) => {
    dataChannelLog.textContent += `< ${evt.data}\n`;
    if (evt.data.startsWith("pong")) {
      const elapsedMs = timeStamp() - parseInt(evt.data.slice(5), 10);
      dataChannelLog.textContent += ` RTT ${elapsedMs} ms\n`;
    }
    if (evt.data.startsWith("{")) {
      handleImage(evt.data);
    }
  };

  await negotiate();

  document.getElementById("stop").style.display = "inline-block";
}

// Stop the WebRTC connection
function stop() {
  document.getElementById("stop").style.display = "none";

  // Close the data channel
  if (dataChannel) {
    dataChannel.close();
  }

  // Close transceivers
  if (pc.getTransceivers) {
    pc.getTransceivers().forEach((transceiver) => {
      if (transceiver.stop) {
        transceiver.stop();
      }
    });
  }

  // Close local audio / video tracks
  pc.getSenders().forEach((sender) => {
    if (sender.track) {
      sender.track.stop();
    }
  });

  // Close the peer connection
  setTimeout(() => {
    if (pc) {
      pc.close();
    }
  }, 500);
}

// Event listener for the stop button
document.getElementById("stop").onclick = stop;

// Start everything
start();
console.timeEnd("loading");
