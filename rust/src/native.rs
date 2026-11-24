use std::panic::{UnwindSafe, catch_unwind};
use std::ptr;
use std::slice;
use std::sync::Mutex;

use crate::client::{Client, MAX_IDENTIFIER_BYTES};
use crate::exchange::{CAPACITY, REJECTED, dispatch, write_action};
use crate::wire::{KEY_BYTES, MAX_FRAME_BYTES};

const INVALID_ARGUMENT: i32 = -2;
const PANICKED: i32 = -3;

#[cfg(test)]
mod tests;

pub struct NativeClient(Mutex<Client>);

#[unsafe(no_mangle)]
pub extern "C" fn nt_client_buffer_capacity() -> usize {
    CAPACITY
}

#[unsafe(no_mangle)]
pub extern "C" fn nt_client_max_frame_bytes() -> usize {
    MAX_FRAME_BYTES
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn nt_client_create(
    key: *const u8,
    key_length: usize,
    name: *const u8,
    name_length: usize,
    port_count: u32,
    out_client: *mut *mut NativeClient,
) -> i32 {
    if out_client.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: The caller supplies writable storage for one handle, separate from the inputs.
    unsafe { out_client.write(ptr::null_mut()) };
    if key.is_null()
        || key_length != KEY_BYTES
        || name.is_null()
        || name_length > MAX_IDENTIFIER_BYTES
    {
        return INVALID_ARGUMENT;
    }
    guarded(|| {
        // SAFETY: The caller keeps the designated ranges readable for this call.
        let key = unsafe { slice::from_raw_parts(key, key_length) };
        let name = unsafe { slice::from_raw_parts(name, name_length) };
        let Some(client) = std::str::from_utf8(name)
            .ok()
            .and_then(|name| Client::new(key, name, u64::from(port_count)))
        else {
            return REJECTED;
        };
        let handle = Box::into_raw(Box::new(NativeClient(Mutex::new(client))));
        // SAFETY: The output slot remains writable until this call returns.
        unsafe { out_client.write(handle) };
        0
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn nt_client_step(
    handle: *mut NativeClient,
    operation: u32,
    input: *const u8,
    input_length: usize,
    output: *mut u8,
    output_capacity: usize,
) -> i32 {
    if handle.is_null()
        || input_length > CAPACITY
        || (input.is_null() && input_length != 0)
        || output.is_null()
        || output_capacity < CAPACITY
    {
        return INVALID_ARGUMENT;
    }
    guarded(|| {
        // SAFETY: The caller holds a live handle and does not destroy it during this call.
        let Ok(mut client) = unsafe { &*handle }.0.lock() else {
            return PANICKED;
        };
        let input = if input_length == 0 {
            &[]
        } else {
            // SAFETY: The caller keeps nonempty input readable for this call.
            unsafe { slice::from_raw_parts(input, input_length) }
        };
        let action = dispatch(&mut client, operation, input);
        write_action(action, |kind, bytes| {
            // SAFETY: The caller provides a separate writable output range. Only the returned
            // bytes are initialized, so the caller can supply an uninitialized output buffer.
            unsafe {
                output.write(kind);
                ptr::copy_nonoverlapping(bytes.as_ptr(), output.add(1), bytes.len());
            }
        })
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn nt_client_destroy(handle: *mut NativeClient) -> i32 {
    guarded(|| {
        if !handle.is_null() {
            // SAFETY: The caller passes a live handle exactly once, with no other calls in flight.
            drop(unsafe { Box::from_raw(handle) });
        }
        0
    })
}

fn guarded(action: impl FnOnce() -> i32 + UnwindSafe) -> i32 {
    match catch_unwind(action) {
        Ok(result) => result,
        Err(payload) => {
            // Dropping an arbitrary panic payload can itself panic.
            std::mem::forget(payload);
            PANICKED
        }
    }
}
