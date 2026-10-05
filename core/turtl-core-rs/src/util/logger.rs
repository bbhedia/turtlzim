use ::config;
#[cfg(not(target_arch = "wasm32"))]
use ::fern;
use ::log;
#[cfg(not(target_arch = "wasm32"))]
use ::time;
use crate::error::{TResult, TError};
#[cfg(not(target_arch = "wasm32"))]
use ::std::{self, env};
use ::std::fs::File;
#[cfg(not(target_arch = "wasm32"))]
use ::std::fs;
use ::std::io::BufReader;
use ::std::io::prelude::*;
use ::std::sync::RwLock;
#[cfg(not(target_arch = "wasm32"))]
use ::std::sync::Mutex;
#[cfg(not(target_arch = "wasm32"))]
use ::glob;
#[cfg(not(target_arch = "wasm32"))]
use ::std::path::PathBuf;

lazy_static! {
    static ref LOG_SETUP_DONE: RwLock<bool> = RwLock::new(false);
}

/// grab the current logfile from the config. quite hypnotic.
pub fn get_logfile() -> Option<String> {
    let filedest: String = match config::get(&["logging", "file"]) {
        Ok(x) => x,
        Err(_) => return None,
    };
    // if our log file doesn't start with "/" or "x:" then we assume a path
    // relative to the data_folder
    let has_slash = filedest.find("/").unwrap_or(999) == 0;
    let has_colon = filedest.find(":").unwrap_or(999) < 2;
    let filedest = if !has_slash && !has_colon {
        if let Ok(data_folder) = config::get::<String>(&["data_folder"]) {
            format!("{}/{}", data_folder, filedest)
        } else {
            filedest
        }
    } else {
        filedest
    };
    Some(filedest)
}

/// read the logfile's contents to a string and return. if logging is not set up
/// then we throw a tantrum. Set `num_lines` to -1 to grab everything.
pub fn read_log(num_lines: i32) -> TResult<String> {
    let logfile = match get_logfile() {
        Some(x) => Ok(x),
        None => TErr!(TError::MissingField(String::from("logging not set up in config"))),
    }?;
    let mut file = File::open(logfile)?;
    if num_lines < 0 {
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        Ok(contents)
    } else {
        let num_lines = num_lines as usize;
        let reader = BufReader::new(file);
        let mut lines: Vec<String> = Vec::with_capacity(1024);
        for line in reader.lines() {
            lines.push(line?);
        }
        let num_log_lines = lines.len();
        if num_log_lines > num_lines {
            lines = lines.split_off(num_log_lines - num_lines);
        }
        Ok(lines.join("\n"))
    }
}

/// rotate a logfile:
///   - move file.log.3 -> file.log.4, file.log.2 -> file.log.3, etc
///   - copy file.log -> file.log.1
///   - truncate file.log
///   - dispose of file.log.4
#[cfg(not(target_arch = "wasm32"))]
fn rotate(logfile: &String) -> TResult<()> {
    let max_size: u64 = config::get(&["logging", "rotation", "size"]).unwrap_or(10485760);
    let keep_logs: u8 = config::get(&["logging", "rotation", "keep"]).unwrap_or(3);
    let metadata = match fs::metadata(&logfile) {
        Ok(meta) => meta,
        Err(e) => {
            warn!("logger::rotate() -- can't stat logfile: {}", e);
            return Ok(())
        }
    };
    if metadata.len() < max_size {
        return Ok(())
    }
    for i in (1..keep_logs).rev() {
        let oldlog = format!("{}.{}", logfile, i);
        let newlog = format!("{}.{}", logfile, i + 1);
        match fs::metadata(&oldlog) {
            Ok(_) => {
                match fs::rename(&oldlog, &newlog) {
                    Ok(_) => info!("logging::rotate() -- rotated {} -> {}", oldlog, newlog),
                    Err(e) => warn!("logging::rotate() -- failed to rename {} -> {}: {}", oldlog, newlog, e),
                }
            }
            // doesn't exist, oh well
            Err(_) => {}
        }
    }
    // now search all log files, removing ones that aren't part of the keep
    // rotation
    let files = glob::glob(format!("{}*", logfile).as_str())?;
    for file in files {
        let file = match file {
            Ok(x) => x,
            Err(_) => continue,
        };

        let mut keep = file == PathBuf::from(&logfile);
        if !keep {
            for i in (1..keep_logs).rev() {
                if file == PathBuf::from(format!("{}.{}", logfile, i)) {
                    keep = true;
                }
            }
        }
        if !keep {
            match fs::remove_file(file.clone()) {
                Ok(_) => info!("logging::rotate() -- removed {:?}", file),
                Err(e) => warn!("logging::rotate() -- failed to remove {:?}: {}", file, e),
            }
        }
    }
    match fs::copy(&logfile, &format!("{}.1", logfile)) {
        Ok(_) => {
            let truncate = fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&logfile);
            match truncate {
                Ok(_) => {}
                Err(e) => warn!("logging::rotate() -- failed to truncate {}: {}", logfile, e),
            }
        }
        Err(e) => {
            warn!("logging::rotate() -- failed to copy {} to {}.1: {}", logfile, logfile, e);
        }
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
lazy_static! {
    /// if we are logging to a logfile, make sure that if it's over a certain
    /// size, we cut it down a bit.
    static ref PRUNE_COUNTER: Mutex<u32> = Mutex::new(0);
}
#[cfg(not(target_arch = "wasm32"))]
fn prune_logfile() -> TResult<()> {
    {
        let mut count_guard = lock!(*PRUNE_COUNTER);
        *count_guard += 1;
        if *count_guard < 1000 { return Ok(()); }
        *count_guard = 0;
        drop(count_guard);
    }
    let logfile = match get_logfile() {
        Some(x) => x,
        None => return Ok(()),
    };
    rotate(&logfile)
}

/// turn a `logging.level` config value into a level filter
fn parse_level(levelstr: &String) -> log::LevelFilter {
    match levelstr.to_lowercase().as_ref() {
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        "off" => log::LevelFilter::Off,
        _ => {
            println!("logger::setup_logger() -- bad `log.level` value (\"{}\"), defaulting to \"warn\"", levelstr);
            log::LevelFilter::Warn
        }
    }
}

/// a simple wrapper (pretty much direct from documentation) that sets up
/// logging to STDOUT (and file if config allows) via fern/log
#[cfg(not(target_arch = "wasm32"))]
pub fn setup_logger() -> TResult<()> {
    let levelstr: String = match env::var("TURTL_LOGLEVEL") {
        Ok(x) => x,
        Err(_) => config::get(&["logging", "level"])?
    };
    let level = parse_level(&levelstr);
    let non_verbose_level = if level < log::LevelFilter::Info { level } else { log::LevelFilter::Info };
    let mut config = fern::Dispatch::new()
        .format(|out, message, record| {
            match prune_logfile() {
                Ok(_) => {},
                Err(e) => {
                    println!("logger::setup_logger() -- prune error: {}", e);
                }
            }
            out.finish(format_args!(
                "{} - [{}][{}] {}",
                time::now().strftime("%Y-%m-%dT%H:%M:%S").expect("turtl::logger::setup_logger() -- failed to parse time or something"),
                record.level(),
                record.target(),
                message
            ))
        })
        .level(level)
        .level_for("tokio_reactor", non_verbose_level.clone())
        .level_for("mio", non_verbose_level.clone())
        .level_for("reqwest", non_verbose_level.clone())
        .level_for("hyper", non_verbose_level.clone())
        .level_for("want", non_verbose_level.clone())
        .level_for("jni", non_verbose_level.clone())
        .level_for("html5ever", non_verbose_level.clone())
        .chain(std::io::stdout());
    if let Some(filedest) = get_logfile() {
        config = config.chain(fern::log_file(filedest)?);
    }
    match config.apply() {
        Ok(_) => {}
        Err(e) => {
            trace!("logger::setup_logger() -- looks like the logger was already init: {}", e);
        }
    }

    let mut init_guard = lockw!(*LOG_SETUP_DONE);
    *init_guard = true;
    drop(init_guard);
    Ok(())
}

/// The wasm32 logger: everything goes to the JS console (which has its own timestamps, and no
/// stdout or log file to offer). `time::now()`, which the native logger stamps lines with, panics
/// on this target.
#[cfg(target_arch = "wasm32")]
mod console {
    use ::wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console, js_name = error)]
        pub fn error(line: &str);
        #[wasm_bindgen(js_namespace = console, js_name = warn)]
        pub fn warn(line: &str);
        #[wasm_bindgen(js_namespace = console, js_name = info)]
        pub fn info(line: &str);
        #[wasm_bindgen(js_namespace = console, js_name = debug)]
        pub fn debug(line: &str);
    }
}

#[cfg(target_arch = "wasm32")]
struct ConsoleLogger;

#[cfg(target_arch = "wasm32")]
impl log::Log for ConsoleLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        // (the `log` crate has already dropped everything above `max_level()`) like the native
        // logger, keep the HTTP client quieter than the rest
        let chatty = metadata.target().starts_with("reqwest");
        let cap = if chatty && log::max_level() > log::LevelFilter::Info { log::LevelFilter::Info } else { log::max_level() };
        metadata.level() <= cap
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) { return; }
        let line = format!("[{}][{}] {}", record.level(), record.target(), record.args());
        match record.level() {
            log::Level::Error => console::error(&line),
            log::Level::Warn => console::warn(&line),
            log::Level::Info => console::info(&line),
            log::Level::Debug | log::Level::Trace => console::debug(&line),
        }
    }

    fn flush(&self) {}
}

#[cfg(target_arch = "wasm32")]
static CONSOLE_LOGGER: ConsoleLogger = ConsoleLogger;

/// Set up logging to the JS console at the configured `logging.level`. (Calling it again just
/// updates the level.)
#[cfg(target_arch = "wasm32")]
pub fn setup_logger() -> TResult<()> {
    let levelstr: String = config::get(&["logging", "level"])?;
    let level = parse_level(&levelstr);
    match log::set_logger(&CONSOLE_LOGGER) {
        Ok(_) => {}
        Err(e) => {
            trace!("logger::setup_logger() -- looks like the logger was already init: {}", e);
        }
    }
    log::set_max_level(level);

    let mut init_guard = lockw!(*LOG_SETUP_DONE);
    *init_guard = true;
    drop(init_guard);
    Ok(())
}

/// Whether or not logging has been set up
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub fn has_init() -> bool {
    let init_guard = lockr!(*LOG_SETUP_DONE);
    *init_guard
}

