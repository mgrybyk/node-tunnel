use serde_json::Value;

use crate::client::{Action, Client};
use crate::wire::{MAX_FRAME_BYTES, NONCE_BYTES};

pub const CAPACITY: usize = MAX_FRAME_BYTES + 2; // action byte and LF
pub const REJECTED: i32 = -1;
pub const REGISTER: u32 = 1;
pub const DISCONNECT: u32 = 2;
pub const CONTROL_FRAME: u32 = 3;
pub const OPEN_TUNNEL: u32 = 4;
pub const PING: u32 = 5;
pub const DATA_PREFACE: u32 = 6;
pub const DATA_FRAME: u32 = 7;
pub const CANCEL: u32 = 8;
const FRAME: u8 = 1;
const EVENT: u8 = 2;

pub fn dispatch(client: &mut Client, operation: u32, input: &[u8]) -> Option<Action> {
    match operation {
        DISCONNECT if input.is_empty() => return Some(client.reset_connection()),
        CONTROL_FRAME => return client.control_frame(input),
        DATA_FRAME => return client.data_frame(input),
        _ => {}
    }
    let (nonce, body) = input.split_first_chunk::<NONCE_BYTES>()?;
    match operation {
        REGISTER if body.is_empty() => client.register(nonce),
        OPEN_TUNNEL => client.open_tunnel(nonce, parse(body)?),
        PING if body.is_empty() => client.ping(nonce),
        DATA_PREFACE => client.data_preface(nonce, parse(body)?),
        CANCEL => client.cancel(nonce, parse(body)?),
        _ => None,
    }
}

pub fn write_action(action: Option<Action>, write: impl FnOnce(u8, &[u8])) -> i32 {
    let (kind, output) = match action {
        Some(Action::None) => return 0,
        Some(Action::Send(frame)) => (FRAME, frame),
        Some(Action::Event(event)) => match serde_json::to_vec(&event) {
            Ok(bytes) => (EVENT, bytes),
            Err(_) => return REJECTED,
        },
        None => return REJECTED,
    };
    if output.len() >= CAPACITY {
        return REJECTED;
    }
    write(kind, &output);
    (output.len() + 1) as i32
}

pub fn parse(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice(bytes).ok()
}
