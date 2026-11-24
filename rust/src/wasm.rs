use std::sync::Mutex;

use crate::client::{Action, Client};
use crate::exchange::{CAPACITY, REJECTED, dispatch, parse, write_action};
use crate::wire::{KEY_BYTES, MAX_FRAME_BYTES};

const CONFIGURE: u32 = 0;

// Each WASM instance owns this state and buffer. The host only accesses the buffer between calls.
static CLIENT: Mutex<Option<Client>> = Mutex::new(None);
static mut BUFFER: [u8; CAPACITY] = [0; CAPACITY];

#[unsafe(no_mangle)]
pub extern "C" fn buffer_ptr() -> *mut u8 {
    (&raw mut BUFFER).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn buffer_capacity() -> usize {
    CAPACITY
}

#[unsafe(no_mangle)]
pub extern "C" fn max_frame_bytes() -> usize {
    MAX_FRAME_BYTES
}

#[unsafe(no_mangle)]
pub extern "C" fn step(operation: u32, length: usize) -> i32 {
    // SAFETY: WASM memory is unshared and calls are synchronous, with no host imports or re-entry.
    let buffer = unsafe { &mut *(&raw mut BUFFER) };
    let Some(input) = buffer.get(..length) else {
        return REJECTED;
    };
    let mut client = CLIENT.lock().expect("client state lock");
    let action = if operation == CONFIGURE {
        let configured = configure(&mut client, input);
        buffer[..length.min(KEY_BYTES)].fill(0);
        configured
    } else {
        client
            .as_mut()
            .and_then(|client| dispatch(client, operation, input))
    };
    write_action(action, |kind, output| {
        buffer[0] = kind;
        buffer[1..1 + output.len()].copy_from_slice(output);
    })
}

fn configure(client: &mut Option<Client>, input: &[u8]) -> Option<Action> {
    let (key, config) = input.split_at_checked(KEY_BYTES)?;
    let config = parse(config)?;
    *client = Some(Client::new(
        key,
        config["name"].as_str()?,
        config["portCount"].as_u64()?,
    )?);
    Some(Action::None)
}
