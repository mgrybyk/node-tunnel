use serde_json::{Value, json};

use crate::wire::{Codec, NONCE_BYTES, PROTOCOL_VERSION, is_version};

const MAX_IDENTIFIER_UNITS: usize = 128;
#[cfg(not(target_arch = "wasm32"))]
pub const MAX_IDENTIFIER_BYTES: usize = MAX_IDENTIFIER_UNITS * 3;

pub enum Action {
    None,
    Send(Vec<u8>),
    Event(Value),
}

pub struct Client {
    codec: Codec,
    name: String,
    port_count: u64,
    uuid: Option<String>,
    registered: bool,
    ready: bool,
}

impl Client {
    pub fn new(key: &[u8], name: &str, port_count: u64) -> Option<Self> {
        if !valid_identifier(name) || !(1..=32).contains(&port_count) {
            return None;
        }
        Some(Self {
            codec: Codec::new(key)?,
            name: name.into(),
            port_count,
            uuid: None,
            registered: false,
            ready: false,
        })
    }

    pub fn reset_connection(&mut self) -> Action {
        self.registered = false;
        self.ready = false;
        Action::None
    }

    pub fn register(&mut self, nonce: &[u8; NONCE_BYTES]) -> Option<Action> {
        self.reset_connection();
        let mut message = json!({"kind": "control", "type": "client", "name": self.name, "portCount": self.port_count});
        if let Some(uuid) = &self.uuid {
            message["uuid"] = json!(uuid);
        }
        self.send(nonce, message)
    }

    pub fn open_tunnel(&self, nonce: &[u8; NONCE_BYTES], request: Value) -> Option<Action> {
        let request_id = identifier(&request["requestId"])?;
        let port_index = request["portIndex"].as_u64()?;
        if !self.ready || port_index >= self.port_count {
            return None;
        }
        self.send(
            nonce,
            json!({"openTunnel": {"requestId": request_id, "portIndex": port_index}}),
        )
    }

    pub fn ping(&self, nonce: &[u8; NONCE_BYTES]) -> Option<Action> {
        if !self.registered {
            return None;
        }
        self.send(nonce, json!({"ping": true}))
    }

    pub fn data_preface(&self, nonce: &[u8; NONCE_BYTES], ticket: Value) -> Option<Action> {
        let ticket = identifier(&ticket)?;
        self.send(
            nonce,
            json!({"kind": "data", "type": "client", "ticket": ticket}),
        )
    }

    pub fn cancel(&self, nonce: &[u8; NONCE_BYTES], ticket: Value) -> Option<Action> {
        let ticket = identifier(&ticket)?;
        if !self.registered {
            return None;
        }
        self.send(nonce, json!({"cancelTunnel": {"ticket": ticket}}))
    }

    pub fn control_frame(&mut self, frame: &[u8]) -> Option<Action> {
        let message = self.codec.decode(frame)?;
        message.as_object()?;
        if !is_version(&message) {
            let version = message
                .get("protocolVersion")
                .filter(|v| !v.is_null())
                .map_or_else(
                    || "unknown".to_owned(),
                    |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned),
                );
            return Some(Action::Event(
                json!({"type": "fatal", "error": format!("protocol version mismatch: client={PROTOCOL_VERSION}, relay={version}")}),
            ));
        }
        if let Some(error) = message["error"].as_str().filter(|error| !error.is_empty()) {
            return Some(Action::Event(json!({"type": "fatal", "error": error})));
        }
        if let Some(registration) = message.get("registration") {
            let uuid = identifier(&registration["uuid"])?;
            let ready = registration["ready"].as_bool()?;
            self.uuid = Some(uuid.into());
            self.registered = true;
            self.ready = ready;
            return Some(Action::Event(
                json!({"type": "registration", "ready": ready}),
            ));
        }
        if !self.registered {
            return None;
        }
        if message["pong"].as_bool() == Some(true) {
            return Some(Action::Event(json!({"type": "pong"})));
        }
        if let Some(open) = message.get("openTunnel") {
            let request_id = identifier(&open["requestId"])?;
            let ticket = identifier(&open["ticket"])?;
            return Some(Action::Event(
                json!({"type": "open-data", "requestId": request_id, "ticket": ticket}),
            ));
        }
        if let Some(error) = message.get("tunnelError") {
            let request_id = identifier(&error["requestId"])?;
            return Some(Action::Event(
                json!({"type": "tunnel-error", "requestId": request_id, "error": error["error"]}),
            ));
        }
        Some(Action::None)
    }

    pub fn data_frame(&self, frame: &[u8]) -> Option<Action> {
        let message = self.codec.decode(frame)?;
        if !is_version(&message) || message["ready"].as_bool() != Some(true) {
            return None;
        }
        Some(Action::Event(json!({"type": "start-forwarding"})))
    }

    fn send(&self, nonce: &[u8; NONCE_BYTES], message: Value) -> Option<Action> {
        self.codec.encode(nonce, message).map(Action::Send)
    }
}

fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| valid_identifier(text))
}

fn valid_identifier(text: &str) -> bool {
    !text.is_empty() && text.encode_utf16().count() <= MAX_IDENTIFIER_UNITS
}
