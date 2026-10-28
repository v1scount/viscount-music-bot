use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use tracing::warn;

const DISCONTINUITY: u32 = u32::MAX;

/// Discord voice consumes 20 ms Opus frames at 48 kHz stereo.
const SAMPLE_RATE: u64 = 48_000;
const FRAME_SAMPLES: usize = 960;
const FRAME_BYTES: usize = FRAME_SAMPLES * 2 * 2;

/// How far decoded audio stays ahead of the wall clock.
///
/// This host is a 4-core i5-6400 that is often swapping. Discord's player
/// inserts silence (and then stops) when a 20 ms frame is late. A half-second
/// lead absorbs that without the decoder running away from playback.
const LEAD: Duration = Duration::from_millis(500);

/// Extra wait after the lead drains so the last samples are not clipped
/// while they are still in the socket or the Discord jitter buffer.
const DRAIN_SLACK: Duration = Duration::from_millis(40);

const CHANNEL_FRAMES: usize = 128;

#[derive(Clone)]
struct PcmFrame {
    gen: u64,
    bytes: Vec<u8>,
}

/// Fan-out of framed PCM. Spotify decodes 44.1 kHz stereo; bytes written to
/// subscribers are 48 kHz s16le stereo, in Discord-sized frames.
#[derive(Clone)]
pub struct PcmHub {
    inner: Arc<HubInner>,
}

struct Subscriber {
    id: u64,
    tx: SyncSender<PcmFrame>,
}

struct HubInner {
    /// Standard-library channels. Librespot decodes inside its own Tokio
    /// runtime, and Tokio's blocking_send panics from that thread.
    txs: Mutex<Vec<Subscriber>>,
    next_id: AtomicU64,
    gen: AtomicU64,
    sink_stopped: AtomicBool,
    state: Mutex<HubState>,
}

struct HubState {
    resampler: PcmResampler,
    pacer: Pacer,
    /// Incomplete 20 ms frame for the current segment.
    partial: Vec<u8>,
    segment: u64,
}

struct Pacer {
    origin: Option<Instant>,
    sent_frames: u64,
    /// Resume should keep the samples already queued, not burst another lead.
    hold_lead: bool,
}

pub struct PcmResampler {
    inner: FastFixedIn<f64>,
    left: Vec<f64>,
    right: Vec<f64>,
    pos: usize,
    out_channels: Vec<Vec<f64>>,
}

impl PcmHub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HubInner {
                txs: Mutex::new(Vec::new()),
                next_id: AtomicU64::new(1),
                gen: AtomicU64::new(1),
                sink_stopped: AtomicBool::new(false),
                state: Mutex::new(HubState {
                    resampler: PcmResampler::new(),
                    pacer: Pacer::new(),
                    partial: Vec::with_capacity(FRAME_BYTES),
                    segment: 1,
                }),
            }),
        }
    }

    fn subscribe(&self) -> Receiver<PcmFrame> {
        let (tx, rx) = mpsc::sync_channel(CHANNEL_FRAMES);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .txs
            .lock()
            .expect("pcm subscribers")
            .push(Subscriber { id, tx });
        rx
    }

    pub fn current_gen(&self) -> u64 {
        self.inner.gen.load(Ordering::Acquire)
    }

    /// Drop queued audio and tell the bot to reopen its playback stream.
    /// Called on load, seek, and stop — not on pause.
    pub fn begin_segment(&self) {
        let gen = self.inner.gen.fetch_add(1, Ordering::AcqRel) + 1;
        {
            let mut state = self.inner.state.lock().expect("pcm state");
            state.resampler.reset();
            state.pacer.reset();
            state.partial.clear();
            state.segment = gen;
        }
        self.emit_detached(PcmFrame {
            gen,
            bytes: DISCONTINUITY.to_le_bytes().to_vec(),
        });
    }

    /// Librespot calls this for the first start and again on resume.
    pub fn note_sink_start(&self) {
        if !self.inner.sink_stopped.swap(false, Ordering::AcqRel) {
            return;
        }
        let mut state = self.inner.state.lock().expect("pcm state");
        if state.pacer.sent_frames > 0 {
            state.pacer.hold_lead = true;
        }
    }

    pub fn note_sink_stop(&self) {
        self.inner.sink_stopped.store(true, Ordering::Release);
    }

    pub fn push_samples(&self, samples: &[f64]) {
        let gen = self.current_gen();
        let pcm = {
            let mut state = self.inner.state.lock().expect("pcm state");
            if state.segment != gen {
                return;
            }
            state.resampler.push(samples)
        };
        self.write_paced(gen, &pcm);
    }

    /// Pad the last partial frame and wait until queued audio should have
    /// been played. End-of-track is delivered after this, so the bot does
    /// not skip the tail still sitting in the Discord buffer.
    pub fn finish_track(&self) {
        let gen = self.current_gen();
        let tail = {
            let mut state = self.inner.state.lock().expect("pcm state");
            if state.segment != gen {
                return;
            }
            state.resampler.flush()
        };
        self.write_paced(gen, &tail);

        let partial = {
            let mut state = self.inner.state.lock().expect("pcm state");
            if state.segment != gen {
                return;
            }
            std::mem::take(&mut state.partial)
        };
        if !partial.is_empty() && self.current_gen() == gen {
            let mut frame = partial;
            frame.resize(FRAME_BYTES, 0);
            self.emit_and_pace(gen, frame);
        }

        loop {
            if self.current_gen() != gen {
                return;
            }
            let wait = {
                let state = self.inner.state.lock().expect("pcm state");
                if state.segment != gen {
                    return;
                }
                state.pacer.backlog()
            };
            if wait.is_zero() {
                break;
            }
            std::thread::sleep(wait.min(Duration::from_millis(20)));
        }
        if self.current_gen() == gen {
            std::thread::sleep(DRAIN_SLACK);
        }
    }

    fn write_paced(&self, gen: u64, pcm: &[u8]) {
        if pcm.is_empty() || self.current_gen() != gen {
            return;
        }
        let mut partial = {
            let mut state = self.inner.state.lock().expect("pcm state");
            if state.segment != gen {
                return;
            }
            std::mem::take(&mut state.partial)
        };

        let mut offset = 0;
        while offset < pcm.len() {
            if self.current_gen() != gen {
                return;
            }
            let need = FRAME_BYTES - partial.len();
            let take = need.min(pcm.len() - offset);
            partial.extend_from_slice(&pcm[offset..offset + take]);
            offset += take;
            if partial.len() < FRAME_BYTES {
                break;
            }
            let frame = std::mem::take(&mut partial);
            if !self.emit_and_pace(gen, frame) {
                return;
            }
        }

        let mut state = self.inner.state.lock().expect("pcm state");
        if state.segment == gen {
            state.partial = partial;
        }
    }

    fn emit_and_pace(&self, gen: u64, frame: Vec<u8>) -> bool {
        if self.current_gen() != gen {
            return false;
        }
        self.emit_blocking(PcmFrame {
            gen,
            bytes: frame_bytes(&frame),
        });
        self.pace_frame(gen);
        self.current_gen() == gen
    }

    fn pace_frame(&self, gen: u64) {
        let target = {
            let mut state = self.inner.state.lock().expect("pcm state");
            if state.segment != gen {
                return;
            }
            state.pacer.prepare_resume();
            if state.pacer.origin.is_none() {
                state.pacer.origin = Some(Instant::now());
            }
            state.pacer.sent_frames += FRAME_SAMPLES as u64;
            let sent = frames_to_duration(state.pacer.sent_frames);
            let origin = state.pacer.origin.unwrap_or_else(Instant::now);
            origin + sent.saturating_sub(LEAD)
        };
        while self.current_gen() == gen {
            let now = Instant::now();
            if now >= target {
                break;
            }
            std::thread::sleep((target - now).min(Duration::from_millis(20)));
        }
    }

    fn emit_blocking(&self, frame: PcmFrame) {
        let senders = self.inner.txs.lock().expect("pcm subscribers").clone();
        if senders.is_empty() {
            return;
        }
        let mut closed = Vec::new();
        for subscriber in &senders {
            if subscriber.tx.send(frame.clone()).is_err() {
                closed.push(subscriber.id);
            }
        }
        if !closed.is_empty() {
            self.drop_ids(&closed);
        }
    }

    /// Used from request handlers, which must not block a Tokio worker.
    fn emit_detached(&self, frame: PcmFrame) {
        let senders = self.inner.txs.lock().expect("pcm subscribers").clone();
        let mut closed = Vec::new();
        for subscriber in senders {
            match subscriber.tx.try_send(frame.clone()) {
                Ok(()) => {}
                Err(TrySendError::Disconnected(_)) => closed.push(subscriber.id),
                Err(TrySendError::Full(pending)) => {
                    let tx = subscriber.tx.clone();
                    std::thread::spawn(move || {
                        let _ = tx.send(pending);
                    });
                }
            }
        }
        if !closed.is_empty() {
            self.drop_ids(&closed);
        }
    }

    fn drop_ids(&self, ids: &[u64]) {
        self.inner
            .txs
            .lock()
            .expect("pcm subscribers")
            .retain(|subscriber| !ids.contains(&subscriber.id));
    }
}

impl Clone for Subscriber {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            tx: self.tx.clone(),
        }
    }
}

impl Pacer {
    fn new() -> Self {
        Self {
            origin: None,
            sent_frames: 0,
            hold_lead: false,
        }
    }

    fn reset(&mut self) {
        self.origin = None;
        self.sent_frames = 0;
        self.hold_lead = false;
    }

    fn prepare_resume(&mut self) {
        if !self.hold_lead {
            return;
        }
        self.hold_lead = false;
        let sent = frames_to_duration(self.sent_frames);
        if sent.is_zero() {
            return;
        }
        let lead = LEAD.min(sent);
        self.origin = Instant::now().checked_sub(sent.saturating_sub(lead));
    }

    fn backlog(&self) -> Duration {
        let Some(origin) = self.origin else {
            return Duration::ZERO;
        };
        let sent = frames_to_duration(self.sent_frames);
        let elapsed = Instant::now().saturating_duration_since(origin);
        sent.saturating_sub(elapsed)
    }
}

impl PcmResampler {
    fn new() -> Self {
        let inner = FastFixedIn::<f64>::new(
            SAMPLE_RATE as f64 / 44_100.0,
            1.1,
            PolynomialDegree::Septic,
            1024,
            2,
        )
        .expect("48 kHz resampler");
        let out_channels = inner.output_buffer_allocate(true);
        Self {
            inner,
            left: Vec::new(),
            right: Vec::new(),
            pos: 0,
            out_channels,
        }
    }

    fn reset(&mut self) {
        self.inner.reset();
        self.left.clear();
        self.right.clear();
        self.pos = 0;
    }

    fn available(&self) -> usize {
        self.left.len().saturating_sub(self.pos)
    }

    fn push(&mut self, samples: &[f64]) -> Vec<u8> {
        let frames = samples.len() / 2;
        if frames == 0 {
            return Vec::new();
        }
        self.left.reserve(frames);
        self.right.reserve(frames);
        for frame in 0..frames {
            self.left.push(samples[frame * 2]);
            self.right.push(samples[frame * 2 + 1]);
        }
        let mut out = Vec::new();
        self.drain_ready(&mut out);
        out
    }

    fn flush(&mut self) -> Vec<u8> {
        let pending = self.available();
        if pending == 0 {
            return Vec::new();
        }
        let left = self.left[self.pos..].to_vec();
        let right = self.right[self.pos..].to_vec();
        self.left.clear();
        self.right.clear();
        self.pos = 0;
        let mut out = Vec::new();
        match self.inner.process_partial(Some(&[left, right]), None) {
            Ok(channels) => {
                encode_planar(&channels, &mut out);
                trim_trailing_silence(&mut out);
            }
            Err(error) => warn!("resample flush failed: {error}"),
        }
        out
    }

    fn drain_ready(&mut self, out: &mut Vec<u8>) {
        loop {
            let need = self.inner.input_frames_next();
            if self.available() < need {
                break;
            }
            let left = self.left[self.pos..self.pos + need].to_vec();
            let right = self.right[self.pos..self.pos + need].to_vec();
            self.pos += need;
            if self.pos > 4096 && self.pos * 2 > self.left.len() {
                self.left.drain(..self.pos);
                self.right.drain(..self.pos);
                self.pos = 0;
            }
            match self
                .inner
                .process_into_buffer(&[&left, &right], &mut self.out_channels, None)
            {
                Ok((_, produced)) => encode_indexed(&self.out_channels, produced, out),
                Err(error) => {
                    warn!("resample failed: {error}");
                    break;
                }
            }
        }
    }
}

fn encode_indexed(channels: &[Vec<f64>], frames: usize, out: &mut Vec<u8>) {
    out.reserve(frames * 4);
    for frame in 0..frames {
        for channel in 0..2 {
            push_sample(channels[channel][frame], out);
        }
    }
}

fn encode_planar(channels: &[Vec<f64>], out: &mut Vec<u8>) {
    let frames = channels.first().map(Vec::len).unwrap_or(0);
    encode_indexed(channels, frames, out);
}

fn push_sample(sample: f64, out: &mut Vec<u8>) {
    let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f64).round() as i16;
    out.extend_from_slice(&pcm.to_le_bytes());
}

fn trim_trailing_silence(pcm: &mut Vec<u8>) {
    while pcm.len() >= 4 && pcm[pcm.len() - 4..].iter().all(|byte| *byte == 0) {
        pcm.truncate(pcm.len() - 4);
    }
}

fn frame_bytes(pcm: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(4 + pcm.len());
    framed.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    framed.extend_from_slice(pcm);
    framed
}

fn frames_to_duration(frames: u64) -> Duration {
    Duration::from_nanos(frames.saturating_mul(1_000_000_000) / SAMPLE_RATE)
}

/// Hand a newly accepted socket to a plain thread. The player thread cannot
/// block on a Tokio channel, so the socket is written outside the runtime.
pub fn spawn_subscriber(socket: tokio::net::TcpStream, hub: PcmHub) {
    let socket = match socket.into_std() {
        Ok(socket) => socket,
        Err(error) => {
            warn!("pcm socket: {error}");
            return;
        }
    };
    if let Err(error) = socket.set_nonblocking(false) {
        warn!("pcm blocking mode: {error}");
    }
    let rx = hub.subscribe();
    std::thread::spawn(move || serve_subscriber(socket, rx, hub));
}

fn serve_subscriber(mut socket: std::net::TcpStream, rx: Receiver<PcmFrame>, hub: PcmHub) {
    let _ = socket.set_nodelay(true);
    while let Ok(frame) = rx.recv() {
        if frame.gen != hub.current_gen() {
            continue;
        }
        if socket.write_all(&frame.bytes).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_duration_is_realtime_at_48khz() {
        assert_eq!(frames_to_duration(48_000), Duration::from_secs(1));
        assert_eq!(frames_to_duration(960), Duration::from_millis(20));
    }

    #[test]
    fn resampler_converts_44100_to_about_48000() {
        let mut resampler = PcmResampler::new();
        let input_frames = 44_100;
        let mut input = Vec::with_capacity(input_frames * 2);
        for frame in 0..input_frames {
            let sample = (frame as f64 * 440.0 * std::f64::consts::TAU / 44_100.0).sin() * 0.4;
            input.push(sample);
            input.push(sample);
        }
        let pcm = resampler.push(&input);
        let output_frames = pcm.len() / 4;
        assert!(
            (46_000..49_500).contains(&output_frames),
            "expected about 48000 frames, got {output_frames}"
        );
        assert!(pcm.chunks(2).any(|sample| sample != [0, 0]));
    }
}
