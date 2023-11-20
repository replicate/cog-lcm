console.time("connecting");
console.time("loading");

// Initialize global state
let lastPrompt = null;
let lastSeed = null;
let waiting = false;
let dataChannel = null;
let dataChannelOpen = false;
let pc = null;
let timeStart = null;
let servers = [];

// Cached DOM elements
const promptInput = document.getElementById("prompt");
const seedInput = document.getElementById("seed");

const latencyField = document.getElementById("latency");
const genTimeField = document.getElementById("gen-time");
const rtcPingField = document.getElementById("rtc-ping");
const estimatedClockDriftField = document.getElementById(
  "estimated-clock-drift",
);
const generationStatusLog = document.getElementById("generation-state");

const dataChannelLog = document.getElementById("data-channel");
const iceConnectionLog = document.getElementById("ice-connection-state");
const iceGatheringLog = document.getElementById("ice-gathering-state");
const signalingLog = document.getElementById("signaling-state");

// Utility function to wait for a specified amount of time
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let generation_elapsed = null;
let last_prompt_data;

async function waitForPrompt(getter) {
  while (true) {
    let prompt = getter();
    let prompt_data = JSON.stringify(prompt);
    if (prompt_data && prompt_data !== last_prompt_data) {
      last_prompt_data = prompt_data;
      console.time("generation");
      return prompt;
    }

    await wait(100);
  }
}

// Function to get prompt data
async function getPrompt() {
  return await waitForPrompt(() => {
    if (!(promptInput && promptInput.value)) {
      return null;
    }
    return {
      prompt: promptInput.value,
      seed: seedInput.value,
      height: 512,
      width: 512,
    };
  });
}

// Function to handle incoming image data
function handleImage(data) {
  waiting = false;
  console.log("handling image!");
  const parsed = JSON.parse(data);
  latencyField.textContent = `generation latency: ${Math.round(
    Date.now() - parsed.id,
  )}ms`;
  genTimeField.textContent = `server generation time: ${parsed.gen_time}ms`;
  generationStatusLog.textContent += ` -(${generation_elapsed(
    parsed.start,
  )})-> server_start`;
  generationStatusLog.textContent += ` -(${generation_elapsed(
    parsed.end,
  )})-> server_end`;
  generationStatusLog.textContent += ` -(${generation_elapsed()})-> received`;
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
    let interval;
    const trySend = () => {
      if (dataChannel && dataChannelOpen) {
        dataChannelLog.textContent += "> " + prompt + "\n";
        generation_elapsed = make_elapsed(true);
        prompt.id = Date.now();
        generationStatusLog.textContent = "sent";
        dataChannel.send(JSON.stringify(prompt));
        clearInterval(interval);
      } else {
        console.log("No connections open, retrying");
      }
    };
    trySend();
    interval = setInterval(trySend, 1000);
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
function make_elapsed(precis = false) {
  let last = Date.now();
  return (set_to = null) => {
    const now = set_to == null ? Date.now() : set_to;
    const elapsed = precis
      ? `${Math.round(now - last)}ms`
      : `${Math.round((now - last) / 100) / 10}s`;
    last = now;
    return elapsed;
  };
}

// Peer connection setup
async function createPeerConnection() {
  const config = {
    sdpSemantics: "unified-plan",
  };

  gather_elapsed = make_elapsed((precis = true));
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
        urls: "turn:a.relay.metered.ca:443",
        username: "d0d9c8df0b9e209b5f81f70d",
        credential: "32ANR/GokUdBpWrp",
      },
      // {
      //   urls: "turn:a.relay.metered.ca:80?transport=tcp",
      //   username: "d0d9c8df0b9e209b5f81f70d",
      //   credential: "32ANR/GokUdBpWrp",
      // },
      // {
      //   urls: "turn:a.relay.metered.ca:443?transport=tcp",
      //   username: "d0d9c8df0b9e209b5f81f70d",
      //   credential: "32ANR/GokUdBpWrp",
      // },
      // {
      //   urls: "turn:216.153.63.64:3478?transport=tcp",
      //   credential: "fakecred",
      //   username: "fakeuser",
      // },
      // { urls: "stun:216.153.63.64:3478" },
    ];
    /*SERVERS*/
    /*
    const response = await fetch(
      "https://sylvie-test.metered.live/api/v1/turn/credentials?apiKey=fb2f54b77cc9ed3fd8f5ab1152aa37c6a43d",
    );

    // Saving the response in the iceServers array
    config.iceServers = await response.json();
    */
    servers = config.iceServers;
    console.log(servers);
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
    const offer_data = JSON.stringify({
      sdp: offerSDP.sdp,
      type: offerSDP.type,
    });
    const response = await fetch("/offer", {
      body: JSON.stringify({
        offer: offer_data,
        servers: JSON.stringify(servers),
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
  pc = await createPeerConnection();
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
      let [our_time, their_time] = evt.data.slice(5).split(" ", 2);
      const elapsedMs = timeStamp() - parseInt(our_time, 10);
      const estimated_server_time = parseInt(their_time, 10) + elapsedMs / 2;
      estimatedClockDriftField.textContent = `estimated clock drift from server: ${Math.round(
        Date.now() - estimated_server_time,
      )}ms`;
      dataChannelLog.textContent += ` RTT ${elapsedMs} ms\n`;
      rtcPingField.textContent = `webRTC roundtrip ping: ${elapsedMs}ms`;
    } else {
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
