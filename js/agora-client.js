// ============================================================================
// AGORA RTC EVENT HANDLERS
// ============================================================================
// This module handles real-time events from the Agora RTC client:
// - User join/leave
// - Media published/unpublished
// - Stream messages (transcription/translation data)

/**
 * Subscribe to a remote user's media (audio or video)
 * 
 * When a remote user publishes media, we:
 * 1. Subscribe to receive their stream
 * 2. Create UI elements to display video and transcriptions
 * 3. Initialize language selector for translation viewing
 * 
 * @param {Object} user - Agora user object with tracks
 * @param {string} mediaType - "audio" or "video"
 */
async function subscribe(user, mediaType) {
  const uid = user.uid;
  await client.subscribe(user, mediaType);
  console.log(`[${new Date().toLocaleTimeString()}] Subscribed to ${uid} for ${mediaType}`);
  
  if (mediaType === "video") {
    // Clean up any existing container (prevents duplicates)
    $(`#video-wrapper-${uid}`).remove();
    
    // Create video container with transcription overlay structure
    const player = $(`
      <div id="video-wrapper-${uid}" class="video-wrapper">
        <div class="language-selector">
          <select id="translation-lang-${uid}" 
                  class="bg-gray-800 rounded px-2 py-1 text-sm" 
                  onchange="updateTranslationView('${uid}')">
          </select>
        </div>
        <div class="video-container">
          <div id="player-${uid}" class="w-full h-full"></div>
          <div class="transcription-overlay">
            <div id="transcriptioncaps-${uid}" class="text-xl mb-2"></div>
            <div id="translationcaps-${uid}" class="text-gray-300"></div>
          </div>
        </div>
      </div>
    `);
    $("#remote-playerlist").append(player);
    
    // Play the video track in the container
    user.videoTrack.play(`player-${uid}`);
    
    // Initialize the translation language selector dropdown
    updateLanguageSelector(uid);
  }
  
  if (mediaType === "audio") {
    // Audio plays automatically through system speakers
    user.audioTrack.play();
  }
}

// Host automatically sends transcription + translation languages; joiners receive and update transcript UI only
var STT_LANGUAGES_MSG_TYPE = "stt-languages";

function sendSttLanguagesToChannel() {
  if (!taskId || !client) return;
  try {
    var speaking = getSpeakingLanguagesConfig();
    var pairs = (translationSettings.pairs || []).map(function (p) {
      return { source: p.source, targets: p.targets || [] };
    });
    var payload = { type: STT_LANGUAGES_MSG_TYPE, speaking: speaking, translationPairs: pairs };
    client.sendStreamMessage(stringToUint8Array(JSON.stringify(payload)));
  } catch (e) {
    console.error("Failed to send STT languages to channel:", e);
  }
}

var rttLogLines = {
  "rtt-log-transcribe": [],
  "rtt-log-translate": [],
  "rtt-log-final": []
};

function visibleRttLines(elementId) {
  var lines = rttLogLines[elementId] || [];
  var transcribeOnly = document.getElementById(elementId + "-transcribe");
  var translateOnly = document.getElementById(elementId + "-translate");
  if (transcribeOnly && transcribeOnly.checked) {
    return lines.filter(function (entry) { return entry.kind === "transcribe"; });
  }
  if (translateOnly && translateOnly.checked) {
    return lines.filter(function (entry) { return entry.kind === "translate"; });
  }
  return lines;
}

function setRttTypeFilter(elementId, which) {
  var transcribe = document.getElementById(elementId + "-transcribe");
  var translate = document.getElementById(elementId + "-translate");
  if (!transcribe || !translate) return;
  if (which === "transcribe" && transcribe.checked) {
    translate.checked = false;
    translate.disabled = true;
    transcribe.disabled = false;
  } else if (which === "translate" && translate.checked) {
    transcribe.checked = false;
    transcribe.disabled = true;
    translate.disabled = false;
  } else {
    transcribe.disabled = false;
    translate.disabled = false;
  }
  renderRttLog(elementId);
}

function renderRttLog(elementId) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var lines = visibleRttLines(elementId);
  var lastOnly = document.getElementById(elementId + "-last");
  var showLast = lastOnly && lastOnly.checked;
  var pinTop = elementId !== "rtt-log-final" && el.scrollTop < 8;
  var texts = lines.map(function (entry) { return entry.text; });
  el.value = showLast ? (texts.length ? texts[texts.length - 1] : "") : texts.join("\n");
  if (showLast) return;
  if (elementId !== "rtt-log-final") {
    if (pinTop) el.scrollTop = 0;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

function appendRttLog(elementId, line, kind) {
  if (!line) return;
  if (!rttLogLines[elementId]) rttLogLines[elementId] = [];
  rttLogLines[elementId].push({ text: line, kind: kind || "other" });
  renderRttLog(elementId);
}

function clearRttLogs() {
  rttLogLines["rtt-log-transcribe"] = [];
  rttLogLines["rtt-log-translate"] = [];
  rttLogLines["rtt-log-final"] = [];
  renderRttLog("rtt-log-transcribe");
  renderRttLog("rtt-log-translate");
  renderRttLog("rtt-log-final");
}

// Update stream message handler
client.on("stream-message", function(uid, data) {
  try {
    if (data && (data instanceof Uint8Array ? data[0] === 0x7B : (data.byteLength && new Uint8Array(data)[0] === 0x7B))) {
      try {
        var str = utf8ArrayToString(data);
        var parsed = JSON.parse(str);
        if (parsed && parsed.type === STT_LANGUAGES_MSG_TYPE && !taskId) {
          setBroadcastedSupportedLanguages({ speaking: parsed.speaking || [], translationPairs: parsed.translationPairs || [] });
          if (typeof renderTranscriptsModalContent === "function") renderTranscriptsModalContent();
          return;
        }
      } catch (e) {}
    }

    const Text = $protobufRoot.lookup("agora.audio2text.Text");
    const msg = Text.decode(data);
    
    // Show the transcription overlay and start auto-hide timer
    showOverlay(msg.uid);
    
    // Get current timestamp for logging
    const timestamp = new Date().toLocaleTimeString();
    
    // Handle transcription messages
    if (msg.data_type === "transcribe" && msg.words && msg.words.length) {
      // Join all word fragments into a single string
      const text = msg.words.map(word => word.text).join("");
      
      // Update the transcription overlay for this user
      $(`#video-wrapper-${msg.uid} #transcriptioncaps-${msg.uid}`).text(text);
      
      console.log(`[${timestamp}] Transcription from ${msg.uid}: ${text}`);
      
      // Optional: Add to history log
      addTranscribeItem(msg.uid, text);
      if (text.trim()) {
        appendRttLog("rtt-log-transcribe", `[${timestamp}] uid ${msg.uid} transcribe: ${text}`, "transcribe");
      }
      const hasFinal = msg.words.some(w => w.isFinal === true);
      if (hasFinal && text.trim()) {
        appendRttLog("rtt-log-final", `[${timestamp}] uid ${msg.uid} transcribe: ${text}`, "transcribe");
        var speakingLangs = getSpeakingLanguagesConfig();
        var idx = typeof msg.lang === 'number' ? msg.lang : (msg.lang != null ? parseInt(msg.lang, 10) : NaN);
        var sourceLang = (!isNaN(idx) && speakingLangs[idx] != null) ? speakingLangs[idx] : undefined;
        if (!sourceLang && speakingLangs.length === 1) sourceLang = speakingLangs[0];
        transcriptHistory.push({
          uid: msg.uid,
          time: timestamp,
          transcriptText: text.trim(),
          sourceLang: sourceLang,
          translations: {}
        });
      }
    }
    else if (msg.data_type === "translate" && msg.trans && msg.trans.length) {
      // Get the user's currently selected translation language
      const selectedLang = $(`#translation-lang-${msg.uid}`).val();
      
      // Find the translation for the selected language
      // msg.trans is an array of translations (one per target language)
      const translation = msg.trans.find(t => t.lang === selectedLang);
      
      if (translation) {
        const text = translation.texts.join("");
        
        // Update the translation overlay for this user
        $(`#video-wrapper-${msg.uid} #translationcaps-${msg.uid}`).text(text);
        
        console.log(`[${timestamp}] Translation (${selectedLang}) from ${msg.uid}: ${text}`);
        
        // Optional: Add to history log
        addTranslateItem(msg.uid, text);
      }
      msg.trans.forEach(t => {
        const allText = (t.texts || []).join("");
        if (allText.trim()) {
          appendRttLog("rtt-log-translate", `[${timestamp}] uid ${msg.uid} translate ${t.lang}: ${allText}`, "translate");
        }
      });
      if (translation && translation.isFinal === true) {
        const finalText = (translation.texts || []).join("");
        if (finalText.trim()) {
          appendRttLog("rtt-log-final", `[${timestamp}] uid ${msg.uid} translate ${selectedLang}: ${finalText}`, "translate");
        }
      }
      // Add final translations to the last transcript segment for this uid
      let segmentToUpdate = transcriptHistory.filter(s => s.uid === msg.uid).pop();
      msg.trans.forEach(t => {
        if (t.isFinal === true && t.texts && t.texts.length) {
          const transText = t.texts.join("").trim();
          if (transText) {
            if (segmentToUpdate) {
              segmentToUpdate.translations[t.lang] = transText;
            } else {
              const newSeg = {
                uid: msg.uid,
                time: timestamp,
                transcriptText: "",
                translations: { [t.lang]: transText }
              };
              transcriptHistory.push(newSeg);
              segmentToUpdate = newSeg;
            }
          }
        }
      });
    }
  } catch (error) {
    console.error("Error handling stream message:", error);
    // Don't throw - gracefully handle decode errors
  }
});

/**
 * Handle remote user publishing media
 * 
 * When a remote user publishes audio or video:
 * 1. Automatically subscribe to their stream
 * 2. Create UI elements for video display
 * 3. Play the media (video renders in DOM, audio plays through speakers)
 * 
 * Note: This can fire multiple times if a user unpublishes and republishes.
 * We check for existing containers to prevent duplicates.
 */
client.on("user-joined", function(user) {
  if (rttPubBotUid === '' || rttPubBotUid == null) return;
  if (String(user.uid) !== String(rttPubBotUid)) return;
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] uid ${user.uid} user-joined: RTT pubBot`;
  appendRttLog("rtt-log-transcribe", line, "join");
  appendRttLog("rtt-log-translate", line, "join");
  appendRttLog("rtt-log-final", line, "join");
});

client.on("user-published", async function(user, mediaType) {
  // Subscribe to receive the media stream
  await client.subscribe(user, mediaType);
  
  if (mediaType === "video") {
    // Check if container already exists (prevent duplicate video tiles)
    const existingContainers = $(`[id^="video-wrapper-${user.uid}"]`);
    if (existingContainers.length) {
      // Remove duplicate containers, keep only the first
      existingContainers.slice(1).remove();
      
      // If video is already playing, no need to recreate
      if ($(`#player-${user.uid} video`).length) {
        return;
      }
    }

    // Clean up any orphaned player divs (shouldn't happen, but defensive)
    $(`#player-${user.uid}`).not(`#video-wrapper-${user.uid} #player-${user.uid}`).remove();

    // Create complete video container with transcription support
    const playerContainer = $(`
      <div id="video-wrapper-${user.uid}" class="video-wrapper">
        <div class="language-selector">
          <select id="translation-lang-${user.uid}" 
                  class="bg-gray-800 rounded px-2 py-1 text-sm" 
                  onchange="updateTranslationView('${user.uid}')">
          </select>
        </div>
        <div class="remote-video">
          <div id="player-${user.uid}" class="w-full h-full"></div>
          <div class="transcription-overlay">
            <div id="transcriptioncaps-${user.uid}" class="text-xl mb-2"></div>
            <div id="translationcaps-${user.uid}" class="text-gray-300"></div>
          </div>
        </div>
      </div>
    `);

    // Only append if container doesn't exist
    if (!$(`#video-wrapper-${user.uid}`).length) {
      $("#remote-playerlist").append(playerContainer);
    }
    
    // Play the video track in the container
    user.videoTrack.play(`player-${user.uid}`);
    
    // Initialize translation language selector
    updateLanguageSelector(user.uid);
  }
  
  if (mediaType === "audio") {
    // Play audio through system speakers
    user.audioTrack.play();
  }
  if (taskId) sendSttLanguagesToChannel();
});

/**
 * Handle remote user unpublishing media
 * 
 * When a user stops publishing or leaves the channel:
 * 1. Clear any pending overlay auto-hide timers
 * 2. Remove their video container and UI elements
 * 
 * This is called when:
 * - User explicitly unpublishes (stops camera/mic)
 * - User leaves the channel
 * - Network connection drops
 */
client.on("user-unpublished", function(user) {
  // Clear pending overlay timeout to prevent memory leaks
  if (overlayTimeouts.has(user.uid)) {
    clearTimeout(overlayTimeouts.get(user.uid));
    overlayTimeouts.delete(user.uid);
  }
  
  // Remove all UI elements for this user
  $(`[id^="video-wrapper-${user.uid}"]`).remove();
  $(`[id^="player-${user.uid}"]`).remove();
});

