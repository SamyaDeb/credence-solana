//! Epoch times from the session calendar (plan/02 §1). Pure functions over `Session` slices; all times are Unix
//! seconds (UTC) taken from the calendar, so daylight-saving changes (US clocks change Nov 1, 2026) are already in the
//! data and nothing here converts time zones.

use crate::state::{closure, Session};

/// Cover sales stop this long before the regular close (plan/02 §1: 15 minutes).
pub const BELL_BEFORE_CLOSE: i64 = 15 * 60;
/// Settlement window after the open (plan/02 §4: 5 minutes).
pub const SETTLE_WINDOW: i64 = 5 * 60;

/// Days since 1970-01-01 of a `yyyymmdd` date (proleptic Gregorian; Howard Hinnant's `days_from_civil`).
/// `None` for a malformed date.
pub fn days_from_civil(yyyymmdd: u32) -> Option<i64> {
    let (y, m, d) = ((yyyymmdd / 10_000) as i64, ((yyyymmdd / 100) % 100) as i64, (yyyymmdd % 100) as i64);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1970 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// ISO weekday, Monday = 1 … Sunday = 7.
pub fn weekday(days: i64) -> i64 {
    (days + 3).rem_euclid(7) + 1
}

/// Times of one closure, Unix seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EpochTimes {
    pub closure_type: u8,
    pub sale_open: i64,
    pub bell: i64,
    pub close: i64,
    pub open: i64,
    pub settle_after: i64,
}

/// Times of the closure after the session dated `closure_id`.
///
/// - `close` = that session's close (a half day closes early: the bell moves with it);
/// - `open` = the next session's open; `settle_after = open + 5 min`;
/// - `bell = close − 15 min`;
/// - `sale_open` = the open of the first session of that week (Monday, or Tuesday after a Monday holiday).
///
/// The closure type is `WEEKEND` when the session is a Friday and the next one is the following Monday,
/// `HOLIDAY_WEEKEND` when the gap is longer and spans a weekend, else `OVERNIGHT`. `None` if `closure_id` is not a
/// session or is the last one.
pub fn epoch_times(sessions: &[Session], closure_id: u32) -> Option<EpochTimes> {
    let i = sessions.binary_search_by_key(&closure_id, |s| s.date).ok()?;
    let (s, next) = (sessions[i], *sessions.get(i + 1)?);
    let (d0, d1) = (days_from_civil(s.date)?, days_from_civil(next.date)?);
    let gap = d1 - d0;
    let closure_type = if weekday(d0) == 5 && gap == 3 {
        closure::WEEKEND
    } else if weekday(d0) + gap > 7 {
        closure::HOLIDAY_WEEKEND
    } else {
        closure::OVERNIGHT
    };
    // First session of the week: earliest session j ≤ i with date ≥ Monday of d0's week.
    let monday = d0 - (weekday(d0) - 1);
    let mut j = i;
    while j > 0 && days_from_civil(sessions[j - 1].date)? >= monday {
        j -= 1;
    }
    Some(EpochTimes {
        closure_type,
        sale_open: sessions[j].open,
        bell: s.close.checked_sub(BELL_BEFORE_CLOSE)?,
        close: s.close,
        open: next.open,
        settle_after: next.open.checked_add(SETTLE_WINDOW)?,
    })
}

/// Checks a calendar chunk: dates ascending and valid, each session's open before its close, sessions in order.
pub fn sessions_valid(sessions: &[Session]) -> bool {
    sessions.iter().all(|s| days_from_civil(s.date).is_some() && s.open < s.close)
        && sessions.windows(2).all(|w| w[0].date < w[1].date && w[0].close < w[1].open)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(days_from_civil(19700101), Some(0));
        assert_eq!(weekday(0), 4); // Thursday
        let oct9 = days_from_civil(20261009).unwrap();
        assert_eq!(weekday(oct9), 5); // Friday
        assert_eq!(days_from_civil(20261102).unwrap() - days_from_civil(20261030).unwrap(), 3);
        assert_eq!(days_from_civil(20270301).unwrap() - days_from_civil(20270228).unwrap(), 1);
        assert_eq!(days_from_civil(20261301), None);
    }
}
