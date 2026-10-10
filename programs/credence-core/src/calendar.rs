//! Epoch times from the session calendar. Pure functions over `Session` slices; all times are Unix
//! seconds (UTC) taken from the calendar, so daylight-saving changes (US clocks change Nov 1, 2026) are already in the
//! data and nothing here converts time zones.

use crate::state::{closure, Session};

/// Cover sales stop this long before the regular close (15 minutes).
pub const BELL_BEFORE_CLOSE: i64 = 15 * 60;
/// Settlement window after the open (5 minutes).
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

/// Times of the NAV closure that starts at the strike on the UTC date `closure_id` (D4): `close` = that day's strike at
/// `anchor_ts`'s time of day, `open` = the next strike, `bell = close − 15 min`, `sale_open = close − interval`. `None` unless
/// `closure_id` is a date on the schedule (on or after the anchor, a whole number of intervals from it) and the interval is a
/// whole number of days.
pub fn nav_times(anchor_ts: i64, interval_secs: u32, closure_id: u32) -> Option<EpochTimes> {
    let interval = interval_secs as i64;
    if interval < 86_400 || interval % 86_400 != 0 || interval > 7 * 86_400 {
        return None;
    }
    let close = days_from_civil(closure_id)?.checked_mul(86_400)?.checked_add(anchor_ts.rem_euclid(86_400))?;
    if close < anchor_ts || (close - anchor_ts) % interval != 0 {
        return None;
    }
    let open = close.checked_add(interval)?;
    Some(EpochTimes {
        closure_type: closure::NAV_STRIKE,
        sale_open: close.checked_sub(interval)?,
        bell: close.checked_sub(BELL_BEFORE_CLOSE)?,
        close,
        open,
        settle_after: open.checked_add(SETTLE_WINDOW)?,
    })
}

/// The closure a Gap Oracle feed describes at `now`: the first one whose settlement window has not ended
/// (`next open + SETTLE_WINDOW > now`), i.e. the one in progress (closed, waiting for the open) or the upcoming one.
/// Returns the closing session's `closure_id`; `None` when the calendar has no closure left.
pub fn feed_closure(sessions: &[Session], now: i64) -> Option<u32> {
    // Opens ascend, so "already settled" is a prefix of sessions[1..].
    let settled = sessions.get(1..)?.partition_point(|s| s.open.saturating_add(SETTLE_WINDOW) <= now);
    sessions.get(settled + 1)?;
    Some(sessions[settled].date)
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
    fn feed_closure_follows_the_open() {
        let s = |date: u32, open: i64, close: i64| Session { date, _pad: 0, open, close };
        let v = [s(20261008, 1_000, 2_000), s(20261009, 3_000, 4_000), s(20261012, 10_000, 11_000)];
        // The Thu→Fri closure is current until Friday's open + 5 min; then the Fri→Mon one until Monday's.
        assert_eq!(feed_closure(&v, 0), Some(20261008));
        assert_eq!(feed_closure(&v, 3_000 + SETTLE_WINDOW - 1), Some(20261008));
        assert_eq!(feed_closure(&v, 3_000 + SETTLE_WINDOW), Some(20261009));
        assert_eq!(feed_closure(&v, 10_000 + SETTLE_WINDOW - 1), Some(20261009));
        // Nothing left in this calendar after Monday's window.
        assert_eq!(feed_closure(&v, 10_000 + SETTLE_WINDOW), None);
    }

    #[test]
    fn nav_times_follow_the_schedule() {
        // Strikes daily at 00:00 UTC from 2026-10-01.
        let anchor = days_from_civil(20261001).unwrap() * 86_400;
        let t = nav_times(anchor, 86_400, 20261012).unwrap();
        let close = days_from_civil(20261012).unwrap() * 86_400;
        assert_eq!((t.close, t.open, t.bell, t.sale_open), (close, close + 86_400, close - 900, close - 86_400));
        assert_eq!((t.closure_type, t.settle_after), (closure::NAV_STRIKE, close + 86_400 + SETTLE_WINDOW));
        assert!(nav_times(anchor, 86_400, 20260930).is_none(), "before the anchor");
        // A 2-day schedule: only every second date is a strike.
        assert!(nav_times(anchor, 2 * 86_400, 20261003).is_some() && nav_times(anchor, 2 * 86_400, 20261002).is_none());
        // Time of day of the anchor carries over.
        let t = nav_times(anchor + 7_200, 86_400, 20261012).unwrap();
        assert_eq!(t.close, close + 7_200);
        // Intervals that are not whole days, or longer than a week, or dates that do not exist.
        assert!(nav_times(anchor, 3_600, 20261012).is_none() && nav_times(anchor, 86_400 + 1, 20261012).is_none());
        assert!(nav_times(anchor, 8 * 86_400, 20261009).is_none() && nav_times(anchor, 86_400, 20261399).is_none());
    }

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
