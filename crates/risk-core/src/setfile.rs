//! Scenario-set, joint-set and risk-bundle files (ADR-0106): parse, build and validate.
//!
//! These files are the interface between calibration (QE), `risk-cli`, `risk-py` and
//! `contracts/script/LoadScenarioSet.s.sol`. The on-chain payloads are the `packed` words; everything else is
//! metadata or a check.
//!
//! - **scenario set** (`credence.scenario-set/v1`): one (asset, closure type), N ascending z values packed
//!   16 × int16 per word (lane 0 = least-significant bits, == `PackedInt.sol`), unused lanes of the last word 0.
//!   `scenarioHash = keccak256(word_0 ‖ … ‖ word_{m−1})` (32-byte big-endian words) is exactly what
//!   `IRiskEngine.scenarioHash(assetId, closureType)` returns after `setScenarioSet`.
//! - **joint set** (`credence.joint-set/v1`): the K stress weekends, one column per asset (same packing, not
//!   sorted; row j of every column is the same weekend). `columnHashes[i] = keccak256(words)` ==
//!   `IRiskEngine.jointHash(assetId)` after `setJointColumn`.
//! - **risk bundle** (`credence.risk-bundle/v1`): what `LoadScenarioSet.s.sol` consumes: `RiskParams`, the set
//!   files, the joint set file, σ floors and initial σ.
//!
//! `contentHash = sha256(tag ‖ payload)` addresses a file by content (the file name carries its first 8 hex
//! digits). It is independent of JSON formatting, key order and the free-form `meta` object.

use crate::fixed::{pack_i16, unpack_i16};
use crate::scenarios::{is_sorted, SliceZ};
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloy_primitives::{keccak256, B256, U256};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Format tag of a scenario-set file.
pub const SET_FORMAT: &str = "credence.scenario-set/v1";
/// Format tag of a joint-set file.
pub const JOINT_FORMAT: &str = "credence.joint-set/v1";
/// Format tag of a risk bundle.
pub const BUNDLE_FORMAT: &str = "credence.risk-bundle/v1";
/// Largest N accepted (bounds the tail scan of `quoteCover`; the guide targets 1,000–3,000).
pub const MAX_SET_LEN: u32 = 16_384;
/// Closure types a scenario set may describe (OVERNIGHT, WEEKEND, HOLIDAY_WEEKEND).
pub const SET_CLOSURE_TYPES: [u8; 3] = [1, 2, 3];

/// A parsed, validated scenario set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScenarioSet {
    /// "NVDA:XNAS" (optional in the file; if present, `assetId == keccak256(asset)`).
    pub asset: Option<String>,
    /// keccak256("TICKER:MIC").
    pub asset_id: B256,
    /// 1 OVERNIGHT, 2 WEEKEND, 3 HOLIDAY_WEEKEND.
    pub closure_type: u8,
    /// Ascending z, thousandths of σ.
    pub z: Vec<i16>,
    /// The on-chain payload.
    pub packed: Vec<U256>,
    /// keccak256 of the packed words (== on-chain `scenarioHash`).
    pub scenario_hash: B256,
    /// sha256 content address.
    pub content_hash: B256,
}

/// One asset's column of the joint stress set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JointColumn {
    /// "NVDA:XNAS".
    pub asset: Option<String>,
    /// keccak256("TICKER:MIC").
    pub asset_id: B256,
    /// K values, weekend order (not sorted).
    pub z: Vec<i16>,
    /// The on-chain payload.
    pub packed: Vec<U256>,
    /// keccak256 of the packed words (== on-chain `jointHash`).
    pub column_hash: B256,
}

/// A parsed, validated joint set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JointSet {
    /// K (256 at launch; must equal `RiskParams.kStress` when loaded).
    pub k: u32,
    /// One column per asset.
    pub columns: Vec<JointColumn>,
    /// sha256 content address.
    pub content_hash: B256,
}

/// A validation error: a JSON path and a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileError {
    /// Where (e.g. `.packed[3]`).
    pub path: String,
    /// What.
    pub msg: String,
}

impl core::fmt::Display for FileError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}: {}", self.path, self.msg)
    }
}

type FResult<T> = Result<T, FileError>;

fn err<T>(path: &str, msg: impl Into<String>) -> FResult<T> {
    Err(FileError {
        path: path.to_string(),
        msg: msg.into(),
    })
}

// ───────────────────────────── hashing ─────────────────────────────

/// keccak256(word_0 ‖ … ‖ word_{m−1}), each word 32 bytes big-endian (== the engine's stored hash).
pub fn words_keccak(words: &[U256]) -> B256 {
    let mut buf = Vec::with_capacity(words.len() * 32);
    for w in words {
        buf.extend_from_slice(&w.to_be_bytes::<32>());
    }
    keccak256(&buf)
}

/// sha256("credence.scenario-set/v1" ‖ assetId ‖ closureType (1 byte) ‖ n (u32 BE) ‖ words).
pub fn set_content_hash(asset_id: B256, closure_type: u8, n: u32, words: &[U256]) -> B256 {
    let mut h = Sha256::new();
    h.update(SET_FORMAT.as_bytes());
    h.update(asset_id.as_slice());
    h.update([closure_type]);
    h.update(n.to_be_bytes());
    for w in words {
        h.update(w.to_be_bytes::<32>());
    }
    B256::from_slice(&h.finalize())
}

/// sha256("credence.joint-set/v1" ‖ k (u32 BE) ‖ for each column: assetId ‖ words).
pub fn joint_content_hash(k: u32, columns: &[(B256, Vec<U256>)]) -> B256 {
    let mut h = Sha256::new();
    h.update(JOINT_FORMAT.as_bytes());
    h.update(k.to_be_bytes());
    for (id, words) in columns {
        h.update(id.as_slice());
        for w in words {
            h.update(w.to_be_bytes::<32>());
        }
    }
    B256::from_slice(&h.finalize())
}

/// keccak256 of an asset key ("NVDA:XNAS").
pub fn asset_id_of(asset: &str) -> B256 {
    keccak256(asset.as_bytes())
}

// ───────────────────────────── building ─────────────────────────────

/// Build a scenario set from ascending z values.
pub fn build_set(asset: &str, closure_type: u8, z: &[i16]) -> FResult<ScenarioSet> {
    check_set_shape(closure_type, z.len())?;
    if !is_sorted(&SliceZ(z)) {
        return err(".z", "not sorted ascending");
    }
    let packed = pack_i16(z);
    let asset_id = asset_id_of(asset);
    Ok(ScenarioSet {
        asset: Some(asset.to_string()),
        asset_id,
        closure_type,
        z: z.to_vec(),
        scenario_hash: words_keccak(&packed),
        content_hash: set_content_hash(asset_id, closure_type, z.len() as u32, &packed),
        packed,
    })
}

/// Build a joint set; `columns` = (asset, z in weekend order), every column K long.
pub fn build_joint(columns: &[(&str, Vec<i16>)]) -> FResult<JointSet> {
    let Some(first) = columns.first() else {
        return err(".columns", "empty");
    };
    let k = first.1.len();
    if k == 0 || k > MAX_SET_LEN as usize {
        return err(".k", format!("K = {k} outside 1..={MAX_SET_LEN}"));
    }
    let mut cols = Vec::with_capacity(columns.len());
    for (i, (asset, z)) in columns.iter().enumerate() {
        if z.len() != k {
            return err(
                &format!(".columns[{i}]"),
                format!("{} entries, K = {k}", z.len()),
            );
        }
        let packed = pack_i16(z);
        cols.push(JointColumn {
            asset: Some(asset.to_string()),
            asset_id: asset_id_of(asset),
            z: z.clone(),
            column_hash: words_keccak(&packed),
            packed,
        });
    }
    check_unique(&cols)?;
    let content_hash = joint_content_hash(
        k as u32,
        &cols
            .iter()
            .map(|c| (c.asset_id, c.packed.clone()))
            .collect::<Vec<_>>(),
    );
    Ok(JointSet {
        k: k as u32,
        columns: cols,
        content_hash,
    })
}

fn check_set_shape(closure_type: u8, n: usize) -> FResult<()> {
    if !SET_CLOSURE_TYPES.contains(&closure_type) {
        return err(
            ".closureType",
            format!("{closure_type} is not 1 (OVERNIGHT), 2 (WEEKEND) or 3 (HOLIDAY_WEEKEND)"),
        );
    }
    if n == 0 || n > MAX_SET_LEN as usize {
        return err(".n", format!("N = {n} outside 1..={MAX_SET_LEN}"));
    }
    Ok(())
}

fn check_unique(cols: &[JointColumn]) -> FResult<()> {
    for i in 0..cols.len() {
        for j in 0..i {
            if cols[i].asset_id == cols[j].asset_id {
                return err(&format!(".columns[{i}]"), "duplicate assetId");
            }
        }
    }
    Ok(())
}

// ───────────────────────────── JSON ─────────────────────────────

fn hex32(w: &U256) -> String {
    format!("0x{w:064x}")
}

/// The file name QE writes: `<TICKER>-<MIC>-<type>-<contentHash[0..8]>.json`.
pub fn set_file_name(s: &ScenarioSet) -> String {
    let base = s
        .asset
        .clone()
        .unwrap_or_else(|| format!("{:x}", s.asset_id))
        .replace(':', "-");
    format!(
        "{base}-{}-{}.json",
        s.closure_type,
        &format!("{:x}", s.content_hash)[..8]
    )
}

/// Serialise a set (`meta` is copied as-is; key order is irrelevant, the hashes cover the payload only).
pub fn set_to_json(s: &ScenarioSet, meta: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("format".into(), json!(SET_FORMAT));
    if let Some(a) = &s.asset {
        m.insert("asset".into(), json!(a));
    }
    m.insert("assetId".into(), json!(format!("{:#x}", s.asset_id)));
    m.insert("closureType".into(), json!(s.closure_type));
    m.insert("n".into(), json!(s.z.len()));
    m.insert(
        "packed".into(),
        Value::Array(s.packed.iter().map(|w| json!(hex32(w))).collect()),
    );
    m.insert(
        "scenarioHash".into(),
        json!(format!("{:#x}", s.scenario_hash)),
    );
    m.insert(
        "contentHash".into(),
        json!(format!("{:#x}", s.content_hash)),
    );
    m.insert("z".into(), json!(s.z));
    if let Some(meta) = meta {
        m.insert("meta".into(), meta);
    }
    Value::Object(m)
}

/// Serialise a joint set.
pub fn joint_to_json(j: &JointSet, meta: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("format".into(), json!(JOINT_FORMAT));
    m.insert("k".into(), json!(j.k));
    m.insert(
        "assets".into(),
        Value::Array(
            j.columns
                .iter()
                .map(|c| json!(c.asset.clone().unwrap_or_default()))
                .collect(),
        ),
    );
    m.insert(
        "assetIds".into(),
        Value::Array(
            j.columns
                .iter()
                .map(|c| json!(format!("{:#x}", c.asset_id)))
                .collect(),
        ),
    );
    m.insert(
        "columns".into(),
        Value::Array(
            j.columns
                .iter()
                .map(|c| Value::Array(c.packed.iter().map(|w| json!(hex32(w))).collect()))
                .collect(),
        ),
    );
    m.insert(
        "columnHashes".into(),
        Value::Array(
            j.columns
                .iter()
                .map(|c| json!(format!("{:#x}", c.column_hash)))
                .collect(),
        ),
    );
    m.insert(
        "contentHash".into(),
        json!(format!("{:#x}", j.content_hash)),
    );
    m.insert(
        "z".into(),
        Value::Array(j.columns.iter().map(|c| json!(c.z)).collect()),
    );
    if let Some(meta) = meta {
        m.insert("meta".into(), meta);
    }
    Value::Object(m)
}

fn field<'a>(o: &'a Map<String, Value>, k: &str) -> FResult<&'a Value> {
    o.get(k).ok_or_else(|| FileError {
        path: format!(".{k}"),
        msg: "missing".into(),
    })
}

fn as_str<'a>(v: &'a Value, path: &str) -> FResult<&'a str> {
    v.as_str().ok_or_else(|| FileError {
        path: path.into(),
        msg: "must be a string".into(),
    })
}

fn as_u64(v: &Value, path: &str) -> FResult<u64> {
    match v {
        Value::Number(n) => n.as_u64().ok_or_else(|| FileError {
            path: path.into(),
            msg: "must be a non-negative integer".into(),
        }),
        Value::String(s) => s.parse::<u64>().map_err(|e| FileError {
            path: path.into(),
            msg: format!("{e}"),
        }),
        _ => err(path, "must be an integer"),
    }
}

fn parse_b256(v: &Value, path: &str) -> FResult<B256> {
    let s = as_str(v, path)?;
    if s.len() != 66 || !s.starts_with("0x") {
        return err(path, "must be 0x + 64 hex digits");
    }
    s.parse::<B256>().map_err(|e| FileError {
        path: path.into(),
        msg: format!("{e}"),
    })
}

fn parse_words(v: &Value, path: &str) -> FResult<Vec<U256>> {
    let arr = v.as_array().ok_or_else(|| FileError {
        path: path.into(),
        msg: "must be an array of 0x words".into(),
    })?;
    arr.iter()
        .enumerate()
        .map(|(i, w)| parse_b256(w, &format!("{path}[{i}]")).map(|b| U256::from_be_bytes(b.0)))
        .collect()
}

fn parse_z(v: &Value, path: &str) -> FResult<Vec<i16>> {
    let arr = v.as_array().ok_or_else(|| FileError {
        path: path.into(),
        msg: "must be an array of integers".into(),
    })?;
    arr.iter()
        .enumerate()
        .map(|(i, x)| {
            x.as_i64()
                .and_then(|x| i16::try_from(x).ok())
                .ok_or_else(|| FileError {
                    path: format!("{path}[{i}]"),
                    msg: "not an int16".into(),
                })
        })
        .collect()
}

/// Unpack `n` lanes and require every unused lane of the last word to be 0 (canonical payload).
fn unpack_canonical(words: &[U256], n: usize, path: &str) -> FResult<Vec<i16>> {
    if words.len() != n.div_ceil(16) {
        return err(
            path,
            format!(
                "{} words for n = {n}, expected {}",
                words.len(),
                n.div_ceil(16)
            ),
        );
    }
    let z: Vec<i16> = (0..n).map(|i| unpack_i16(words[i / 16], i % 16)).collect();
    for lane in n..words.len() * 16 {
        if unpack_i16(words[lane / 16], lane % 16) != 0 {
            return err(
                path,
                format!("unused lane {lane} of the last word is not 0"),
            );
        }
    }
    Ok(z)
}

fn check_format(o: &Map<String, Value>, want: &str) -> FResult<()> {
    let f = as_str(field(o, "format")?, ".format")?;
    if f != want {
        return err(".format", format!("`{f}`, expected `{want}`"));
    }
    Ok(())
}

/// Parse and fully validate a scenario-set file (every rule in ADR-0106 §2).
pub fn parse_set(v: &Value) -> FResult<ScenarioSet> {
    let o = v.as_object().ok_or_else(|| FileError {
        path: ".".into(),
        msg: "must be a JSON object".into(),
    })?;
    check_format(o, SET_FORMAT)?;
    let asset_id = parse_b256(field(o, "assetId")?, ".assetId")?;
    let asset = match o.get("asset") {
        Some(a) => {
            let a = as_str(a, ".asset")?.to_string();
            if asset_id_of(&a) != asset_id {
                return err(".assetId", format!("!= keccak256(\"{a}\")"));
            }
            Some(a)
        }
        None => None,
    };
    let closure_type = as_u64(field(o, "closureType")?, ".closureType")?;
    let closure_type = u8::try_from(closure_type).map_err(|_| FileError {
        path: ".closureType".into(),
        msg: "out of range".into(),
    })?;
    let n = as_u64(field(o, "n")?, ".n")? as usize;
    check_set_shape(closure_type, n)?;
    let packed = parse_words(field(o, "packed")?, ".packed")?;
    let z = unpack_canonical(&packed, n, ".packed")?;
    if !is_sorted(&SliceZ(&z)) {
        let i = (1..z.len()).find(|&i| z[i - 1] > z[i]).unwrap_or(0);
        return err(
            ".packed",
            format!(
                "not sorted ascending at index {i} ({} > {})",
                z[i - 1],
                z[i]
            ),
        );
    }
    if let Some(zv) = o.get("z") {
        if parse_z(zv, ".z")? != z {
            return err(".z", "differs from the unpacked `packed` words");
        }
    }
    let scenario_hash = words_keccak(&packed);
    let content_hash = set_content_hash(asset_id, closure_type, n as u32, &packed);
    if parse_b256(field(o, "scenarioHash")?, ".scenarioHash")? != scenario_hash {
        return err(
            ".scenarioHash",
            format!("!= keccak256(packed) = {scenario_hash:#x}"),
        );
    }
    if parse_b256(field(o, "contentHash")?, ".contentHash")? != content_hash {
        return err(".contentHash", format!("!= {content_hash:#x}"));
    }
    Ok(ScenarioSet {
        asset,
        asset_id,
        closure_type,
        z,
        packed,
        scenario_hash,
        content_hash,
    })
}

/// Parse and fully validate a joint-set file.
pub fn parse_joint(v: &Value) -> FResult<JointSet> {
    let o = v.as_object().ok_or_else(|| FileError {
        path: ".".into(),
        msg: "must be a JSON object".into(),
    })?;
    check_format(o, JOINT_FORMAT)?;
    let k = as_u64(field(o, "k")?, ".k")?;
    if k == 0 || k > MAX_SET_LEN as u64 {
        return err(".k", format!("K = {k} outside 1..={MAX_SET_LEN}"));
    }
    let ids = field(o, "assetIds")?.as_array().ok_or_else(|| FileError {
        path: ".assetIds".into(),
        msg: "must be an array".into(),
    })?;
    let cols = field(o, "columns")?.as_array().ok_or_else(|| FileError {
        path: ".columns".into(),
        msg: "must be an array".into(),
    })?;
    let hashes = field(o, "columnHashes")?
        .as_array()
        .ok_or_else(|| FileError {
            path: ".columnHashes".into(),
            msg: "must be an array".into(),
        })?;
    if ids.is_empty() || cols.len() != ids.len() || hashes.len() != ids.len() {
        return err(
            ".columns",
            "assetIds, columns and columnHashes must be non-empty and the same length",
        );
    }
    let assets = o.get("assets").and_then(|a| a.as_array());
    let zs = o.get("z").and_then(|a| a.as_array());
    let mut out = Vec::with_capacity(ids.len());
    for i in 0..ids.len() {
        let asset_id = parse_b256(&ids[i], &format!(".assetIds[{i}]"))?;
        let asset = match assets.and_then(|a| a.get(i)) {
            Some(a) => {
                let a = as_str(a, &format!(".assets[{i}]"))?.to_string();
                if !a.is_empty() && asset_id_of(&a) != asset_id {
                    return err(&format!(".assetIds[{i}]"), format!("!= keccak256(\"{a}\")"));
                }
                Some(a)
            }
            None => None,
        };
        let packed = parse_words(&cols[i], &format!(".columns[{i}]"))?;
        let z = unpack_canonical(&packed, k as usize, &format!(".columns[{i}]"))?;
        let column_hash = words_keccak(&packed);
        if parse_b256(&hashes[i], &format!(".columnHashes[{i}]"))? != column_hash {
            return err(
                &format!(".columnHashes[{i}]"),
                format!("!= keccak256(column) = {column_hash:#x}"),
            );
        }
        if let Some(zi) = zs.and_then(|z| z.get(i)) {
            if parse_z(zi, &format!(".z[{i}]"))? != z {
                return err(&format!(".z[{i}]"), "differs from the unpacked column");
            }
        }
        out.push(JointColumn {
            asset,
            asset_id,
            z,
            packed,
            column_hash,
        });
    }
    check_unique(&out)?;
    let content_hash = joint_content_hash(
        k as u32,
        &out.iter()
            .map(|c| (c.asset_id, c.packed.clone()))
            .collect::<Vec<_>>(),
    );
    if parse_b256(field(o, "contentHash")?, ".contentHash")? != content_hash {
        return err(".contentHash", format!("!= {content_hash:#x}"));
    }
    Ok(JointSet {
        k: k as u32,
        columns: out,
        content_hash,
    })
}

/// A risk bundle, with its referenced files resolved.
#[derive(Clone, Debug)]
pub struct Bundle {
    /// RiskParams, in struct order: alpha, kappa, theta, costOfCap, eta, beta, uMax, minPremium, kStress.
    pub params: [u64; 9],
    /// Every scenario set.
    pub sets: Vec<ScenarioSet>,
    /// The joint set.
    pub joint: Option<JointSet>,
    /// (assetId, closureType, floor WAD).
    pub sigma_floors: Vec<(B256, u8, U256)>,
    /// (assetId, closureType, σ WAD): initial values.
    pub sigmas: Vec<(B256, u8, U256)>,
}

/// `RiskParams` field names, in struct order.
pub const PARAM_KEYS: [&str; 9] = [
    "alpha",
    "kappa",
    "theta",
    "costOfCap",
    "eta",
    "beta",
    "uMax",
    "minPremium",
    "kStress",
];

fn parse_triples(o: &Map<String, Value>, key: &str, vk: &str) -> FResult<Vec<(B256, u8, U256)>> {
    let Some(t) = o.get(key) else {
        return Ok(Vec::new());
    };
    let path = format!(".{key}");
    let t = t.as_object().ok_or_else(|| FileError {
        path: path.clone(),
        msg: "must be an object of parallel arrays".into(),
    })?;
    let arr = |k: &str| -> FResult<&Vec<Value>> {
        t.get(k)
            .and_then(|a| a.as_array())
            .ok_or_else(|| FileError {
                path: format!("{path}.{k}"),
                msg: "must be an array".into(),
            })
    };
    let (ids, types, vals) = (arr("assetIds")?, arr("closureTypes")?, arr(vk)?);
    if ids.len() != types.len() || ids.len() != vals.len() {
        return err(&path, "parallel arrays differ in length");
    }
    let mut out = Vec::with_capacity(ids.len());
    for i in 0..ids.len() {
        let id = parse_b256(&ids[i], &format!("{path}.assetIds[{i}]"))?;
        let ty = as_u64(&types[i], &format!("{path}.closureTypes[{i}]"))?;
        let v = match &vals[i] {
            Value::String(s) => U256::from_str_radix(s, 10).map_err(|e| FileError {
                path: format!("{path}.{vk}[{i}]"),
                msg: format!("{e}"),
            })?,
            other => U256::from(as_u64(other, &format!("{path}.{vk}[{i}]"))?),
        };
        if !SET_CLOSURE_TYPES.contains(&(ty as u8)) || ty > 3 {
            return err(&format!("{path}.closureTypes[{i}]"), "must be 1, 2 or 3");
        }
        out.push((id, ty as u8, v));
    }
    Ok(out)
}

/// Parse a bundle; `load` reads a referenced file (path relative to the bundle) as JSON.
pub fn parse_bundle(
    v: &Value,
    mut load: impl FnMut(&str) -> Result<Value, String>,
) -> FResult<Bundle> {
    let o = v.as_object().ok_or_else(|| FileError {
        path: ".".into(),
        msg: "must be a JSON object".into(),
    })?;
    check_format(o, BUNDLE_FORMAT)?;
    let p = field(o, "params")?.as_object().ok_or_else(|| FileError {
        path: ".params".into(),
        msg: "must be an object".into(),
    })?;
    let mut params = [0u64; 9];
    for (i, k) in PARAM_KEYS.iter().enumerate() {
        let path = format!(".params.{k}");
        params[i] = as_u64(
            p.get(*k).ok_or_else(|| FileError {
                path: path.clone(),
                msg: "missing".into(),
            })?,
            &path,
        )?;
    }
    let wad = 1_000_000_000_000_000_000u64;
    if params[0] == 0 || params[0] > wad || params[1] >= wad || params[5] > wad || params[6] > wad {
        return err(
            ".params",
            "need 0 < alpha ≤ 1e18, kappa < 1e18, beta ≤ 1e18, uMax ≤ 1e18",
        );
    }
    if params[8] > MAX_SET_LEN as u64 || params[8] > u32::MAX as u64 {
        return err(".params.kStress", "too large");
    }
    let mut sets = Vec::new();
    if let Some(list) = o.get("scenarioSets") {
        let list = list.as_array().ok_or_else(|| FileError {
            path: ".scenarioSets".into(),
            msg: "must be an array of paths".into(),
        })?;
        for (i, f) in list.iter().enumerate() {
            let path = format!(".scenarioSets[{i}]");
            let rel = as_str(f, &path)?;
            let j = load(rel).map_err(|e| FileError {
                path: path.clone(),
                msg: e,
            })?;
            let s = parse_set(&j).map_err(|e| FileError {
                path: format!("{path} ({rel}){}", e.path),
                msg: e.msg,
            })?;
            if sets
                .iter()
                .any(|x: &ScenarioSet| x.asset_id == s.asset_id && x.closure_type == s.closure_type)
            {
                return err(&path, "a second set for the same (assetId, closureType)");
            }
            sets.push(s);
        }
    }
    let joint = match o.get("jointSet") {
        Some(f) => {
            let rel = as_str(f, ".jointSet")?;
            let j = load(rel).map_err(|e| FileError {
                path: ".jointSet".into(),
                msg: e,
            })?;
            let js = parse_joint(&j).map_err(|e| FileError {
                path: format!(".jointSet ({rel}){}", e.path),
                msg: e.msg,
            })?;
            if js.k as u64 != params[8] {
                return err(
                    ".jointSet",
                    format!("K = {} but params.kStress = {}", js.k, params[8]),
                );
            }
            Some(js)
        }
        None => None,
    };
    let sigma_floors = parse_triples(o, "sigmaFloors", "floors")?;
    let sigmas = parse_triples(o, "sigmas", "values")?;
    for (key, list) in [("sigmaFloors", &sigma_floors), ("sigmas", &sigmas)] {
        for i in 0..list.len() {
            if list[..i]
                .iter()
                .any(|t| t.0 == list[i].0 && t.1 == list[i].1)
            {
                return err(
                    &format!(".{key}"),
                    format!("entry {i} repeats an (assetId, closureType)"),
                );
            }
        }
    }
    // The engine rejects `updateSigma` below the floor (SigmaBelowFloor), so an initial σ must clear it.
    for (i, (id, ty, v)) in sigmas.iter().enumerate() {
        if let Some(f) = sigma_floors.iter().find(|f| f.0 == *id && f.1 == *ty) {
            if *v < f.2 {
                return err(
                    &format!(".sigmas.values[{i}]"),
                    format!("{v} is below its floor {}", f.2),
                );
            }
        }
    }
    Ok(Bundle {
        params,
        sets,
        joint,
        sigma_floors,
        sigmas,
    })
}

/// Validate any of the three file kinds (dispatch on `format`) and return a JSON summary.
pub fn validate(v: &Value, load: impl FnMut(&str) -> Result<Value, String>) -> FResult<Value> {
    let f = v.get("format").and_then(|f| f.as_str()).unwrap_or_default();
    match f {
        SET_FORMAT => {
            let s = parse_set(v)?;
            Ok(json!({
                "ok": true, "format": SET_FORMAT, "asset": s.asset, "assetId": format!("{:#x}", s.asset_id),
                "closureType": s.closure_type, "n": s.z.len(), "words": s.packed.len(),
                "min": s.z[0], "max": s.z[s.z.len() - 1],
                "scenarioHash": format!("{:#x}", s.scenario_hash), "contentHash": format!("{:#x}", s.content_hash),
                "fileName": set_file_name(&s),
                "warnings": if (1000..=3000).contains(&s.z.len()) { json!([]) }
                            else { json!([format!("N = {} is outside the guide's 1,000–3,000", s.z.len())]) },
            }))
        }
        JOINT_FORMAT => {
            let j = parse_joint(v)?;
            Ok(json!({
                "ok": true, "format": JOINT_FORMAT, "k": j.k, "columns": j.columns.len(),
                "assetIds": j.columns.iter().map(|c| format!("{:#x}", c.asset_id)).collect::<Vec<_>>(),
                "columnHashes": j.columns.iter().map(|c| format!("{:#x}", c.column_hash)).collect::<Vec<_>>(),
                "contentHash": format!("{:#x}", j.content_hash),
            }))
        }
        BUNDLE_FORMAT => {
            let b = parse_bundle(v, load)?;
            Ok(json!({
                "ok": true, "format": BUNDLE_FORMAT,
                "params": PARAM_KEYS.iter().zip(b.params.iter()).map(|(k, v)| (k.to_string(), json!(v.to_string())))
                    .collect::<Map<_, _>>(),
                "sets": b.sets.iter().map(|s| json!({"assetId": format!("{:#x}", s.asset_id),
                    "closureType": s.closure_type, "n": s.z.len(), "scenarioHash": format!("{:#x}", s.scenario_hash)}))
                    .collect::<Vec<_>>(),
                "jointColumns": b.joint.as_ref().map(|j| j.columns.len()).unwrap_or(0),
                "sigmaFloors": b.sigma_floors.len(), "sigmas": b.sigmas.len(),
            }))
        }
        "" if v.get("kind").is_some() => err(
            ".format",
            "missing; this looks like a pre-ADR-0106 calibration document (`kind`, `packedWords`): \
             rebuild it with `risk-cli build-set` / `build-joint` or `credence_risk.build_set` (ADR-0106 §6)",
        ),
        other => err(
            ".format",
            format!(
                "unknown format `{other}`; one of {SET_FORMAT}, {JOINT_FORMAT}, {BUNDLE_FORMAT}"
            ),
        ),
    }
}

// ───────────────────────────── files on disk ─────────────────────────────

/// Read a JSON file; errors carry the path.
pub fn read_json(path: &std::path::Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: invalid JSON: {e}", path.display()))
}

fn read_root(path: &std::path::Path) -> FResult<(Value, std::path::PathBuf)> {
    let v = read_json(path).map_err(|msg| FileError {
        path: ".".into(),
        msg,
    })?;
    let dir = path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();
    Ok((v, dir))
}

/// Validate a set, joint set or bundle file; a bundle's references resolve relative to its directory.
pub fn validate_path(path: &std::path::Path) -> FResult<Value> {
    let (v, dir) = read_root(path)?;
    validate(&v, |rel| read_json(&dir.join(rel)))
}

/// Parse and validate a scenario-set file.
pub fn load_set_path(path: &std::path::Path) -> FResult<ScenarioSet> {
    parse_set(&read_root(path)?.0)
}

/// Parse and validate a joint-set file.
pub fn load_joint_path(path: &std::path::Path) -> FResult<JointSet> {
    parse_joint(&read_root(path)?.0)
}

/// Parse and validate a bundle and every file it references.
pub fn load_bundle_path(path: &std::path::Path) -> FResult<Bundle> {
    let (v, dir) = read_root(path)?;
    parse_bundle(&v, |rel| read_json(&dir.join(rel)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<i16> {
        let mut z: Vec<i16> = (0..37).map(|i| (i * 211 % 997) as i16 - 500).collect();
        z.sort();
        z
    }

    #[test]
    fn set_round_trip_and_rules() {
        let s = build_set("NVDA:XNAS", 2, &sample()).unwrap();
        let v = set_to_json(&s, Some(json!({"source": "test"})));
        assert_eq!(parse_set(&v).unwrap(), s);
        assert_eq!(s.packed.len(), 3);
        assert!(set_file_name(&s).starts_with("NVDA-XNAS-2-"));

        // every rule trips
        let mut bad = v.clone();
        bad["closureType"] = json!(4);
        assert_eq!(parse_set(&bad).unwrap_err().path, ".closureType");
        let mut bad = v.clone();
        bad["assetId"] = json!(format!("{:#x}", asset_id_of("AAPL:XNAS")));
        assert_eq!(parse_set(&bad).unwrap_err().path, ".assetId");
        let mut bad = v.clone();
        bad["n"] = json!(36);
        assert!(parse_set(&bad).unwrap_err().msg.contains("unused lane"));
        let mut bad = v.clone();
        bad["scenarioHash"] = json!(format!("{:#x}", B256::ZERO));
        assert_eq!(parse_set(&bad).unwrap_err().path, ".scenarioHash");
        let mut bad = v.clone();
        bad["contentHash"] = json!(format!("{:#x}", B256::ZERO));
        assert_eq!(parse_set(&bad).unwrap_err().path, ".contentHash");
        let mut bad = v.clone();
        bad["z"][0] = json!(-501);
        assert_eq!(parse_set(&bad).unwrap_err().path, ".z");
        // unsorted payload (with hashes recomputed so only the order is wrong)
        let mut z = sample();
        z.swap(0, 5);
        let packed = pack_i16(&z);
        let mut bad = v.clone();
        bad["packed"] = Value::Array(packed.iter().map(|w| json!(hex32(w))).collect());
        bad.as_object_mut().unwrap().remove("z");
        assert!(parse_set(&bad).unwrap_err().msg.contains("not sorted"));
        assert!(build_set("X:Y", 2, &z).is_err());
        assert!(build_set("X:Y", 2, &[]).is_err());
    }

    #[test]
    fn joint_round_trip_and_rules() {
        let j = build_joint(&[
            ("NVDA:XNAS", vec![-100, 50, 7]),
            ("AAPL:XNAS", vec![3, -2, 1]),
        ])
        .unwrap();
        let v = joint_to_json(&j, None);
        assert_eq!(parse_joint(&v).unwrap(), j);
        let mut bad = v.clone();
        bad["columnHashes"][1] = json!(format!("{:#x}", B256::ZERO));
        assert_eq!(parse_joint(&bad).unwrap_err().path, ".columnHashes[1]");
        assert!(build_joint(&[("A:B", vec![1, 2]), ("C:D", vec![1])]).is_err());
        assert!(build_joint(&[("A:B", vec![1]), ("A:B", vec![2])]).is_err());
    }

    #[test]
    fn bundle_resolves_files() {
        let s = build_set("NVDA:XNAS", 2, &sample()).unwrap();
        let j = build_joint(&[("NVDA:XNAS", vec![-100, 50, 7])]).unwrap();
        let files = [
            ("s.json", set_to_json(&s, None)),
            ("j.json", joint_to_json(&j, None)),
        ];
        let load = |p: &str| {
            files
                .iter()
                .find(|f| f.0 == p)
                .map(|f| f.1.clone())
                .ok_or_else(|| "missing".to_string())
        };
        let b = json!({"format": BUNDLE_FORMAT,
            "params": {"alpha": "1000000000000000", "kappa": "30000000000000000", "theta": "1000000000000000000",
                "costOfCap": "150000000000000000", "eta": "4000000000000000000", "beta": "975000000000000000",
                "uMax": "500000000000000000", "minPremium": 500000, "kStress": 3},
            "scenarioSets": ["s.json"], "jointSet": "j.json",
            "sigmaFloors": {"assetIds": [format!("{:#x}", s.asset_id)], "closureTypes": [2], "floors": ["20000000000000000"]}});
        let out = validate(&b, load).unwrap();
        assert_eq!(out["sets"][0]["n"], 37);
        assert_eq!(out["jointColumns"], 1);
        let mut bad = b.clone();
        bad["params"]["kStress"] = json!(4);
        assert!(parse_bundle(&bad, load)
            .unwrap_err()
            .msg
            .contains("kStress"));
        let mut bad = b.clone();
        bad["scenarioSets"] = json!(["s.json", "s.json"]);
        assert!(parse_bundle(&bad, load).is_err());
        let id = format!("{:#x}", s.asset_id);
        let mut bad = b.clone();
        bad["sigmas"] =
            json!({"assetIds": [id], "closureTypes": [2], "values": ["19999999999999999"]});
        assert_eq!(
            parse_bundle(&bad, load).unwrap_err().path,
            ".sigmas.values[0]"
        );
        let mut ok = b.clone();
        ok["sigmas"] =
            json!({"assetIds": [id], "closureTypes": [2], "values": ["20000000000000000"]});
        assert_eq!(parse_bundle(&ok, load).unwrap().sigmas.len(), 1);
        let mut bad = b.clone();
        bad["sigmaFloors"] =
            json!({"assetIds": [id, id], "closureTypes": [2, 2], "floors": [1, 2]});
        assert_eq!(parse_bundle(&bad, load).unwrap_err().path, ".sigmaFloors");
    }

    #[test]
    fn scenario_hash_is_keccak_of_abi_packed_words() {
        // lane 0 = least-significant bits: [-1, 2] -> 0x…0002ffff; the hash is keccak256(abi.encodePacked(uint256[]))
        let s = build_set("NVDA:XNAS", 1, &[-1, 2]).unwrap();
        assert_eq!(s.packed, vec![U256::from(0x0002_ffffu64)]);
        let mut word = [0u8; 32];
        word[28..].copy_from_slice(&[0x00, 0x02, 0xff, 0xff]);
        assert_eq!(s.scenario_hash, keccak256(word));
        assert_eq!(
            format!("{:#x}", s.asset_id),
            "0x2ba7fe0221993f0b564e6bd78704eab0e0162888663625d7124a5d01aa95c620"
        );
    }
}
