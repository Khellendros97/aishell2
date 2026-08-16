//! HTTP-date 时间格式（RFC 7231 §7.1.1.1）最小实现。
//!
//! 背景：hyper 的 `server` feature 依赖 crates.io 的 httpdate，而本仓库构建环境无外网
//! （crates.io 下载失败），故以本文件作为 `[patch.crates-io] httpdate` 的本地替换。
//! hyper 运行时只使用 `HttpDate::from(SystemTime)` 的 `Display`（写响应 `Date` 头），
//! 本实现同时提供 parse（三种格式）与比较/转换，API 与上游兼容。

use std::error;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// 解析失败错误（API 兼容上游）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid HTTP-date")
    }
}

impl error::Error for Error {}

/// HTTP-date 时间（RFC 7231 IMF-fixdate，如 `Sun, 06 Nov 1994 08:49:37 GMT`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct HttpDate(pub SystemTime);

impl From<SystemTime> for HttpDate {
    fn from(t: SystemTime) -> Self {
        HttpDate(t)
    }
}

impl From<HttpDate> for SystemTime {
    fn from(d: HttpDate) -> Self {
        d.0
    }
}

/// 格式化：IMF-fixdate（`%a, %d %b %Y %H:%M:%S GMT`）。
impl fmt::Display for HttpDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let secs = match self.0.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as i64,
            Err(e) => -(e.duration().as_secs() as i64),
        };
        let days = secs.div_euclid(86_400);
        let tod = secs.rem_euclid(86_400);
        let (y, m, d) = civil_from_days(days);
        // 1970-01-01 是星期四（DAYS 下标 4）
        let wd = (days.rem_euclid(7) + 4) % 7;
        write!(
            f,
            "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
            DAYS[wd as usize],
            d,
            MONTHS[(m - 1) as usize],
            y,
            tod / 3600,
            (tod % 3600) / 60,
            tod % 60
        )
    }
}

impl std::str::FromStr for HttpDate {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        parse_http_date(s).map(HttpDate)
    }
}

/// 解析 HTTP-date，支持 RFC 7231 的三种格式：
/// - IMF-fixdate：`Sun, 06 Nov 1994 08:49:37 GMT`
/// - RFC 850：`Sunday, 06-Nov-94 08:49:37 GMT`（2 位年份）
/// - asctime：`Sun Nov  6 08:49:37 1994`
pub fn parse_http_date(s: &str) -> Result<SystemTime, Error> {
    let s = s.trim();
    let fields: Vec<&str> = s.split_whitespace().collect();
    // IMF-fixdate（6 字段，逗号分隔星期）
    if fields.len() == 6 && s.ends_with(" GMT") && fields[0].ends_with(',') {
        let day: u32 = fields[1].parse().map_err(|_| Error)?;
        let year: i64 = fields[3].parse().map_err(|_| Error)?;
        return parse_date_time(day, fields[2], year, fields[4]);
    }
    // RFC 850（5 字段，`06-Nov-94` 形式）
    if fields.len() == 5 && s.ends_with(" GMT") && fields[1].contains('-') {
        let mut it = fields[1].split('-');
        if let (Some(d), Some(m), Some(y)) = (it.next(), it.next(), it.next()) {
            if it.next().is_none() {
                let day: u32 = d.parse().map_err(|_| Error)?;
                let yy: i64 = y.parse().map_err(|_| Error)?;
                let year = if (70..=99).contains(&yy) {
                    1900 + yy
                } else {
                    2000 + yy
                };
                return parse_date_time(day, m, year, fields[2]);
            }
        }
    }
    // asctime（5 字段，`Sun Nov  6 08:49:37 1994`）
    if fields.len() == 5 && !fields[0].contains(',') && fields[0].len() == 3 {
        let day: u32 = fields[2].parse().map_err(|_| Error)?;
        let year: i64 = fields[4].parse().map_err(|_| Error)?;
        return parse_date_time(day, fields[1], year, fields[3]);
    }
    Err(Error)
}

/// 格式化（hyper 响应 Date 头用）。
pub fn fmt_http_date(time: SystemTime) -> String {
    HttpDate(time).to_string()
}

/// 组装 `d Mon yyyy hh:mm:ss` 各字段为 SystemTime；非法值返回 Error。
fn parse_date_time(day: u32, mon: &str, year: i64, time: &str) -> Result<SystemTime, Error> {
    let m = MONTHS
        .iter()
        .position(|x| *x == mon)
        .map(|i| i as u32 + 1)
        .ok_or(Error)?;
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 3 {
        return Err(Error);
    }
    let h: u64 = parts[0].parse().map_err(|_| Error)?;
    let mi: u64 = parts[1].parse().map_err(|_| Error)?;
    let se: u64 = parts[2].parse().map_err(|_| Error)?;
    if h > 23 || mi > 59 || se > 60 || day == 0 || day > 31 {
        return Err(Error);
    }
    let days = days_from_civil(year, m, day);
    let secs = days * 86_400 + (h * 3600 + mi * 60 + se) as i64;
    if secs < 0 {
        return Err(Error); // HTTP-date 不支持 1970 之前
    }
    Ok(UNIX_EPOCH + std::time::Duration::from_secs(secs as u64))
}

/// 公历 (y, m, d) → 自 UNIX 纪元（1970-01-01）起的天数（Howard Hinnant 算法）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + (d - 1) as u64; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe as i64 - 719_468
}

/// 自 UNIX 纪元起的天数 → 公历 (y, m, d)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_epoch_is_thursday() {
        let d = HttpDate::from(UNIX_EPOCH);
        assert_eq!(d.to_string(), "Thu, 01 Jan 1970 00:00:00 GMT");
    }

    #[test]
    fn display_known_date() {
        // 1994-11-06 08:49:37 UTC 是星期日
        let secs = days_from_civil(1994, 11, 6) * 86_400 + (8 * 3600 + 49 * 60 + 37);
        let t = UNIX_EPOCH + std::time::Duration::from_secs(secs as u64);
        assert_eq!(HttpDate::from(t).to_string(), "Sun, 06 Nov 1994 08:49:37 GMT");
    }

    #[test]
    fn parse_three_formats() {
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT").unwrap(),
            HttpDate::from(
                UNIX_EPOCH
                    + std::time::Duration::from_secs(
                        (days_from_civil(1994, 11, 6) * 86_400 + 8 * 3600 + 49 * 60 + 37) as u64
                    )
            )
            .0
        );
        assert!(parse_http_date("Sunday, 06-Nov-94 08:49:37 GMT").is_ok());
        assert!(parse_http_date("Sun Nov  6 08:49:37 1994").is_ok());
        assert!(parse_http_date("not a date").is_err());
    }

    #[test]
    fn fmt_parse_roundtrip() {
        let t = SystemTime::now();
        let s = fmt_http_date(t);
        let back = parse_http_date(&s).unwrap();
        // 秒级精度往返（now 含亚秒，取整后可差 1 秒）
        let a = t.duration_since(UNIX_EPOCH).unwrap().as_secs();
        let b = back.duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!((a as i64 - b as i64).abs() <= 1, "{s}");
    }
}
