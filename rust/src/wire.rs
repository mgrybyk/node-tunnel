use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use chacha20poly1305::aead::{AeadInOut, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce, Tag};
use serde_json::Value;

pub const KEY_BYTES: usize = 32;
pub const NONCE_BYTES: usize = 12;
pub const MAX_FRAME_BYTES: usize = 4 * 1024;
pub const PROTOCOL_VERSION: u8 = 9;
const CRYPTO_VERSION: u8 = 1;
const AAD: &[u8] = b"node-tunnel-control";
const TAG_BYTES: usize = 16;
const TAG_OFFSET: usize = 1 + NONCE_BYTES;
const BODY_OFFSET: usize = TAG_OFFSET + TAG_BYTES;
const NODE_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

pub struct Codec(ChaCha20Poly1305);

impl Codec {
    pub fn new(key: &[u8]) -> Option<Self> {
        Some(Self(ChaCha20Poly1305::new_from_slice(key).ok()?))
    }

    pub fn encode(&self, nonce: &[u8; NONCE_BYTES], mut message: Value) -> Option<Vec<u8>> {
        message
            .as_object_mut()?
            .insert("protocolVersion".into(), PROTOCOL_VERSION.into());
        let mut body = serde_json::to_vec(&message).ok()?;
        let tag = self
            .0
            .encrypt_inout_detached(&Nonce::from(*nonce), AAD, body.as_mut_slice().into())
            .ok()?;

        let mut envelope = Vec::with_capacity(BODY_OFFSET + body.len());
        envelope.push(CRYPTO_VERSION);
        envelope.extend_from_slice(nonce);
        envelope.extend_from_slice(tag.as_ref());
        envelope.extend_from_slice(&body);
        let mut frame = STANDARD.encode(envelope).into_bytes();
        if frame.len() > MAX_FRAME_BYTES {
            return None;
        }
        frame.push(b'\n');
        Some(frame)
    }

    pub fn decode(&self, frame: &[u8]) -> Option<Value> {
        if frame.len() > MAX_FRAME_BYTES {
            return None;
        }
        let mut envelope = decode_base64(frame)?;
        if envelope.len() < BODY_OFFSET || envelope[0] != CRYPTO_VERSION {
            return None;
        }
        let (header, body) = envelope.split_at_mut(BODY_OFFSET);
        let nonce = Nonce::try_from(&header[1..TAG_OFFSET]).ok()?;
        let tag = Tag::try_from(&header[TAG_OFFSET..]).ok()?;
        self.0
            .decrypt_inout_detached(&nonce, AAD, body.into(), &tag)
            .ok()?;
        serde_json::from_str(&String::from_utf8_lossy(body)).ok()
    }
}

fn decode_base64(frame: &[u8]) -> Option<Vec<u8>> {
    // Match Buffer's ASCII conversion and acceptance of URL-safe and unpadded base64.
    let mut encoded: Vec<u8> = frame
        .iter()
        .map(|byte| byte & 0x7f)
        .take_while(|byte| *byte != b'=')
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    if encoded.len() % 4 == 1 {
        encoded.pop();
    }
    NODE_BASE64.decode(encoded).ok()
}

pub fn is_version(message: &Value) -> bool {
    message.get("protocolVersion").and_then(Value::as_f64) == Some(f64::from(PROTOCOL_VERSION))
}
