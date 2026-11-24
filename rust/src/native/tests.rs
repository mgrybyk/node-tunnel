use serde_json::{Value, json};

use super::*;
use crate::exchange::{CONTROL_FRAME, DATA_FRAME, DISCONNECT, OPEN_TUNNEL, PING, REGISTER};
use crate::wire::Codec;

const FIRST_KEY: &[u8; 32] = b"0123456789abcdef0123456789abcdef";
const SECOND_KEY: &[u8; 32] = b"fedcba9876543210fedcba9876543210";

struct Handle(*mut NativeClient);

impl Handle {
    fn new(key: &[u8; 32], name: &str) -> Self {
        let mut handle = ptr::null_mut();
        assert_eq!(
            unsafe {
                nt_client_create(
                    key.as_ptr(),
                    key.len(),
                    name.as_ptr(),
                    name.len(),
                    1,
                    &mut handle,
                )
            },
            0
        );
        assert!(!handle.is_null());
        Self(handle)
    }

    fn step(&self, op: u32, input: &[u8]) -> (i32, Vec<u8>) {
        let mut output = vec![0; nt_client_buffer_capacity()];
        let len = unsafe {
            nt_client_step(
                self.0,
                op,
                input.as_ptr(),
                input.len(),
                output.as_mut_ptr(),
                output.len(),
            )
        };
        output.truncate(len.max(0) as usize);
        (len, output)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        assert_eq!(unsafe { nt_client_destroy(self.0) }, 0);
    }
}

fn relay_frame(codec: &Codec, nonce: u8, message: Value) -> Vec<u8> {
    let mut frame = codec.encode(&[nonce; 12], message).unwrap();
    assert_eq!(frame.pop(), Some(b'\n'));
    frame
}

fn frame(codec: &Codec, (_, output): (i32, Vec<u8>)) -> Value {
    assert_eq!(output[0], 1);
    assert_eq!(output.last(), Some(&b'\n'));
    codec.decode(&output[1..output.len() - 1]).unwrap()
}

fn event((_, output): (i32, Vec<u8>)) -> Value {
    assert_eq!(output[0], 2);
    serde_json::from_slice(&output[1..]).unwrap()
}

#[test]
fn independent_clients_keep_their_own_keys_and_session_state() {
    let first = Handle::new(FIRST_KEY, "first");
    let second = Handle::new(SECOND_KEY, "second");
    let first_codec = Codec::new(FIRST_KEY).unwrap();
    let second_codec = Codec::new(SECOND_KEY).unwrap();

    assert_eq!(
        frame(&first_codec, first.step(REGISTER, &[1; 12])),
        json!({"protocolVersion": 9, "kind": "control", "type": "client", "name": "first", "portCount": 1})
    );
    assert_eq!(
        frame(&second_codec, second.step(REGISTER, &[1; 12]))["name"],
        "second"
    );
    let registered = relay_frame(
        &first_codec,
        2,
        json!({"registration": {"uuid": "first-id", "ready": true}}),
    );
    assert_eq!(second.step(CONTROL_FRAME, &registered).0, REJECTED);
    assert_eq!(
        event(first.step(CONTROL_FRAME, &registered)),
        json!({"type": "registration", "ready": true})
    );
    assert_eq!(second.step(PING, &[3; 12]).0, REJECTED);
    assert_eq!(
        frame(&first_codec, first.step(PING, &[3; 12])),
        json!({"protocolVersion": 9, "ping": true})
    );

    let registered = relay_frame(
        &second_codec,
        2,
        json!({"registration": {"uuid": "second-id", "ready": false}}),
    );
    assert_eq!(
        event(second.step(CONTROL_FRAME, &registered)),
        json!({"type": "registration", "ready": false})
    );
    let mut request = vec![4; 12];
    request.extend_from_slice(br#"{"requestId":"request","portIndex":0}"#);
    assert_eq!(second.step(OPEN_TUNNEL, &request).0, REJECTED);
    assert_eq!(
        frame(&first_codec, first.step(OPEN_TUNNEL, &request))["openTunnel"]["requestId"],
        "request"
    );
    assert_eq!(first.step(DISCONNECT, &[]).0, 0);
    assert_eq!(first.step(PING, &[5; 12]).0, REJECTED);
    drop(first);
    assert_eq!(
        frame(&second_codec, second.step(REGISTER, &[5; 12]))["uuid"],
        "second-id"
    );
}

#[test]
fn validates_arguments_and_preserves_caller_buffers() {
    let mut out_client = ptr::dangling_mut();
    let invalid_name = [0xff];
    assert_eq!(
        unsafe {
            nt_client_create(
                FIRST_KEY.as_ptr(),
                FIRST_KEY.len(),
                invalid_name.as_ptr(),
                1,
                1,
                &mut out_client,
            )
        },
        REJECTED
    );
    assert!(out_client.is_null());
    assert_eq!(unsafe { nt_client_destroy(ptr::null_mut()) }, 0);

    let handle = Handle::new(FIRST_KEY, "client");
    let codec = Codec::new(FIRST_KEY).unwrap();
    let ready = relay_frame(&codec, 1, json!({"ready": true}));
    let mut output = [0xaa; CAPACITY];
    assert_eq!(
        unsafe {
            nt_client_step(
                handle.0,
                DATA_FRAME,
                ready.as_ptr(),
                ready.len(),
                output.as_mut_ptr(),
                CAPACITY - 1,
            )
        },
        INVALID_ARGUMENT
    );
    assert_eq!(output, [0xaa; CAPACITY]);
    let output_len = unsafe {
        nt_client_step(
            handle.0,
            DATA_FRAME,
            ready.as_ptr(),
            ready.len(),
            output.as_mut_ptr(),
            CAPACITY,
        )
    } as usize;
    assert_eq!(output[0], 2);
    assert_eq!(&output[1..output_len], br#"{"type":"start-forwarding"}"#);
    assert_eq!(output[output_len], 0xaa);
}

#[test]
fn catches_panics_and_refuses_to_reuse_a_poisoned_client() {
    let handle = Handle::new(FIRST_KEY, "client");
    assert_eq!(
        guarded(|| {
            let _state = unsafe { &*handle.0 }.0.lock().unwrap();
            panic!("test panic while operating on a client");
        }),
        PANICKED
    );
    assert_eq!(handle.step(DISCONNECT, &[]).0, PANICKED);
}
