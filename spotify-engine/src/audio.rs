use std::time::Duration;

use librespot::core::Session;
use librespot::core::spotify_uri::SpotifyUri;
use librespot::playback::audio_backend::{Sink, SinkResult};
use librespot::playback::config::{Bitrate, PlayerConfig};
use librespot::playback::convert::Converter;
use librespot::playback::decoder::AudioPacket;
use librespot::playback::mixer::NoOpVolume;
use librespot::playback::player::{Player, PlayerEvent};

use crate::pcm::PcmHub;

pub struct EnginePlayer {
    pub player: std::sync::Arc<Player>,
}

impl EnginePlayer {
    pub fn new(session: Session, hub: PcmHub) -> Self {
        let mut config = PlayerConfig::default();
        config.bitrate = Bitrate::Bitrate320;
        config.normalisation = true;
        config.position_update_interval = Some(Duration::from_secs(1));

        let player = Player::new(config, session, Box::new(NoOpVolume), move || {
            Box::new(PcmSink::new(hub))
        });

        Self { player }
    }
}

struct PcmSink {
    hub: PcmHub,
}

impl PcmSink {
    fn new(hub: PcmHub) -> Self {
        Self { hub }
    }
}

impl Sink for PcmSink {
    fn start(&mut self) -> SinkResult<()> {
        // Pause and the first play both come through here. A discontinuity
        // on resume would reopen Discord and drop the buffered lead.
        self.hub.note_sink_start();
        Ok(())
    }

    fn stop(&mut self) -> SinkResult<()> {
        self.hub.note_sink_stop();
        Ok(())
    }

    fn write(&mut self, packet: AudioPacket, _converter: &mut Converter) -> SinkResult<()> {
        let samples = match packet.samples() {
            Ok(samples) => samples,
            Err(_) => return Ok(()),
        };
        self.hub.push_samples(samples);
        Ok(())
    }
}

pub fn event_json(event: &PlayerEvent) -> Option<String> {
    let value = match event {
        PlayerEvent::Playing {
            track_id,
            position_ms,
            ..
        } => json_track("playing", track_id, Some(*position_ms)),
        PlayerEvent::Paused {
            track_id,
            position_ms,
            ..
        } => json_track("paused", track_id, Some(*position_ms)),
        PlayerEvent::PositionChanged {
            track_id,
            position_ms,
            ..
        } => json_track("position", track_id, Some(*position_ms)),
        PlayerEvent::Seeked {
            track_id,
            position_ms,
            ..
        } => json_track("seeked", track_id, Some(*position_ms)),
        PlayerEvent::EndOfTrack { track_id, .. } => json_track("end", track_id, None),
        PlayerEvent::Unavailable { track_id, .. } => json_track("unavailable", track_id, None),
        PlayerEvent::Stopped { track_id, .. } => json_track("stopped", track_id, None),
        _ => return None,
    };
    Some(value)
}

fn json_track(kind: &str, track_id: &SpotifyUri, position_ms: Option<u32>) -> String {
    let uri = track_id.to_uri().unwrap_or_default();
    serde_json::json!({
        "type": kind,
        "uri": uri,
        "positionMs": position_ms,
    })
    .to_string()
}
