#![forbid(unsafe_code)]

//! Agent Nanoni's native desktop shell.
//!
//! The Rust crate starts with the shell/host protocol contract.  Transport,
//! process supervision, and Tauri integration are intentionally added by later
//! phase slices.

pub mod app_events;
pub mod bridge;
pub mod host;
pub mod lifecycle;
pub mod opener;
pub mod rpc;
pub mod window;
