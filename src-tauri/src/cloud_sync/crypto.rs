//! 云同步端到端加密和不透明标识。
//!
//! 文件备份的分块容器不在本模块伪造；未定义可验证的容器格式前，调用方只能
//! 把完整密文作为普通 blob 处理，不能把普通密文切片后宣称为可续传文件格式。

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const ENVELOPE_SALT_BYTES: usize = 16;
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;
const ARGON2_OUTPUT_BYTES: usize = KEY_BYTES;
const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    InvalidBase64,
    InvalidSha256,
    InvalidMetadata,
    InvalidPath,
    Randomness,
    Derivation,
    AuthenticationFailed,
    Io(String),
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidBase64 => "base64 格式不合法",
            Self::InvalidSha256 => "SHA-256 校验和不合法",
            Self::InvalidMetadata => "加密元数据不合法",
            Self::InvalidPath => "笔记相对路径不合法",
            Self::Randomness => "无法生成安全随机数",
            Self::Derivation => "密钥派生失败",
            Self::AuthenticationFailed => "密文认证失败",
            Self::Io(message) => message,
        };
        f.write_str(message)
    }
}

impl std::error::Error for CryptoError {}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    // 服务端契约是 memoryKiB（大写 B），序列化/反序列化都对齐它
    #[serde(rename = "memoryKiB")]
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            memory_kib: ARGON2_MEMORY_KIB,
            iterations: ARGON2_ITERATIONS,
            parallelism: ARGON2_PARALLELISM,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMeta {
    pub algorithm: String,
    pub nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_derivation_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEnvelopeMaterial {
    pub algorithm: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedSyncItem {
    pub ciphertext: String,
    pub encryption_meta: EncryptionMeta,
    pub ciphertext_sha256: String,
}

fn random_bytes<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| CryptoError::Randomness)?;
    Ok(bytes)
}

fn strict_standard_base64_decode(value: &str) -> Result<Vec<u8>, CryptoError> {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return Err(CryptoError::InvalidBase64);
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let decoded = engine
        .decode(value)
        .map_err(|_| CryptoError::InvalidBase64)?;
    if engine.encode(&decoded) != value {
        return Err(CryptoError::InvalidBase64);
    }
    Ok(decoded)
}

/// 解码服务端要求的无空白、带 padding 的标准 base64。
pub fn decode_strict_base64(value: &str) -> Result<Vec<u8>, CryptoError> {
    strict_standard_base64_decode(value)
}

/// 编码服务端要求的标准 base64。
pub fn encode_base64(value: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(value)
}

/// 计算小写、固定 64 字符的 SHA-256。
pub fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

/// 严格验证小写十六进制 SHA-256，不接受缩写、空白或大小写变体。
pub fn validate_sha256_hex(value: &str) -> Result<(), CryptoError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CryptoError::InvalidSha256);
    }
    Ok(())
}

fn derive_purpose_key(
    vault_key: &[u8; KEY_BYTES],
    purpose: &str,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    let info = format!("aishell.cloud-sync/v{PROTOCOL_VERSION}/{purpose}");
    let hkdf = Hkdf::<Sha256>::new(None, vault_key);
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    hkdf.expand(info.as_bytes(), key.as_mut())
        .map_err(|_| CryptoError::Derivation)?;
    Ok(key)
}

/// 使用 HKDF-SHA256 做用途隔离，调用方不能把一个用途的 key 复用于另一用途。
pub fn purpose_key(
    vault_key: &[u8; KEY_BYTES],
    purpose: &str,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    if purpose.is_empty()
        || purpose
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_whitespace())
    {
        return Err(CryptoError::Derivation);
    }
    derive_purpose_key(vault_key, purpose)
}

fn argon2(
    password: &[u8],
    params: KdfParams,
    salt: &[u8],
) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    if params.memory_kib == 0
        || params.iterations == 0
        || params.parallelism == 0
        || salt.is_empty()
    {
        return Err(CryptoError::Derivation);
    }
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(ARGON2_OUTPUT_BYTES),
    )
    .map_err(|_| CryptoError::Derivation)?;
    let hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut output = Zeroizing::new([0u8; KEY_BYTES]);
    hasher
        .hash_password_into(password, salt, output.as_mut())
        .map_err(|_| CryptoError::Derivation)?;
    Ok(output)
}

fn seal(
    key: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)
}

fn open(
    key: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            chacha20poly1305::aead::Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::AuthenticationFailed)
}

/// 生成首台设备的随机 vaultKey。
pub fn generate_vault_key() -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    Ok(Zeroizing::new(random_bytes()?))
}

/// 用 Argon2id + XChaCha20-Poly1305 封装 vaultKey，字段可直接映射到 PUT envelope。
pub fn create_key_envelope(
    password: &str,
    vault_key: &[u8; KEY_BYTES],
) -> Result<KeyEnvelopeMaterial, CryptoError> {
    let params = KdfParams::default();
    let salt = random_bytes::<ENVELOPE_SALT_BYTES>()?;
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let kek = argon2(password.as_bytes(), params, &salt)?;
    let aad = b"aishell.cloud-sync/key-envelope/v1";
    let ciphertext = seal(&kek, &nonce, aad, vault_key)?;
    Ok(KeyEnvelopeMaterial {
        algorithm: "xchacha20-poly1305".to_string(),
        kdf: "argon2id".to_string(),
        kdf_params: params,
        salt: encode_base64(&salt),
        nonce: encode_base64(&nonce),
        ciphertext: encode_base64(&ciphertext),
    })
}

/// 解开 envelope；密码和派生密钥只在本函数的临时内存中存在。
pub fn open_key_envelope(
    password: &str,
    envelope: &KeyEnvelopeMaterial,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    if envelope.algorithm != "xchacha20-poly1305" || envelope.kdf != "argon2id" {
        return Err(CryptoError::InvalidMetadata);
    }
    let salt = strict_standard_base64_decode(&envelope.salt)?;
    let nonce = strict_standard_base64_decode(&envelope.nonce)?;
    let ciphertext = strict_standard_base64_decode(&envelope.ciphertext)?;
    if salt.len() != ENVELOPE_SALT_BYTES
        || nonce.len() != NONCE_BYTES
        || ciphertext.len() != KEY_BYTES + 16
    {
        return Err(CryptoError::InvalidMetadata);
    }
    let mut nonce_array = [0u8; NONCE_BYTES];
    nonce_array.copy_from_slice(&nonce);
    let kek = argon2(password.as_bytes(), envelope.kdf_params, &salt)?;
    let plaintext = open(
        &kek,
        &nonce_array,
        b"aishell.cloud-sync/key-envelope/v1",
        &ciphertext,
    )?;
    if plaintext.len() != KEY_BYTES {
        return Err(CryptoError::AuthenticationFailed);
    }
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    key.copy_from_slice(&plaintext);
    Ok(key)
}

fn sync_aad(user_id: &str, entity_type: &str, entity_id: &str, schema_version: u32) -> Vec<u8> {
    fn put(output: &mut Vec<u8>, value: &[u8]) {
        output.extend_from_slice(&(value.len() as u32).to_be_bytes());
        output.extend_from_slice(value);
    }
    let mut aad = b"aishell.cloud-sync/sync-item/v1".to_vec();
    put(&mut aad, user_id.as_bytes());
    put(&mut aad, entity_type.as_bytes());
    put(&mut aad, entity_id.as_bytes());
    aad.extend_from_slice(&schema_version.to_be_bytes());
    aad
}

/// 加密同步项并生成可提交给服务端的 base64 与严格 SHA-256。
pub fn encrypt_sync_item(
    vault_key: &[u8; KEY_BYTES],
    user_id: &str,
    entity_type: &str,
    entity_id: &str,
    schema_version: u32,
    plaintext: &[u8],
) -> Result<EncryptedSyncItem, CryptoError> {
    if user_id.is_empty() || entity_type.is_empty() || entity_id.is_empty() || schema_version == 0 {
        return Err(CryptoError::InvalidMetadata);
    }
    let key = derive_purpose_key(vault_key, "sync-payload")?;
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let ciphertext = seal(
        &key,
        &nonce,
        &sync_aad(user_id, entity_type, entity_id, schema_version),
        plaintext,
    )?;
    Ok(EncryptedSyncItem {
        ciphertext: encode_base64(&ciphertext),
        encryption_meta: EncryptionMeta {
            algorithm: "xchacha20-poly1305".to_string(),
            nonce: encode_base64(&nonce),
            key_derivation_version: None,
            chunk_size: None,
        },
        ciphertext_sha256: sha256_hex(&ciphertext),
    })
}

/// 校验服务端返回的密文摘要、AAD 和 nonce 后解密同步项。
pub fn decrypt_sync_item(
    vault_key: &[u8; KEY_BYTES],
    user_id: &str,
    entity_type: &str,
    entity_id: &str,
    schema_version: u32,
    item: &EncryptedSyncItem,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if item.encryption_meta.algorithm != "xchacha20-poly1305"
        || item.encryption_meta.key_derivation_version.is_some()
        || item.encryption_meta.chunk_size.is_some()
    {
        return Err(CryptoError::InvalidMetadata);
    }
    let ciphertext = strict_standard_base64_decode(&item.ciphertext)?;
    validate_sha256_hex(&item.ciphertext_sha256)?;
    if sha256_hex(&ciphertext) != item.ciphertext_sha256 {
        return Err(CryptoError::AuthenticationFailed);
    }
    let nonce = strict_standard_base64_decode(&item.encryption_meta.nonce)?;
    if nonce.len() != NONCE_BYTES {
        return Err(CryptoError::InvalidMetadata);
    }
    let mut nonce_array = [0u8; NONCE_BYTES];
    nonce_array.copy_from_slice(&nonce);
    let key = derive_purpose_key(vault_key, "sync-payload")?;
    open(
        &key,
        &nonce_array,
        &sync_aad(user_id, entity_type, entity_id, schema_version),
        &ciphertext,
    )
}

/// 规范化笔记相对路径：统一 `/` 和 NFC，拒绝路径逃逸与空段。
pub fn normalize_note_path(path: &str) -> Result<String, CryptoError> {
    let normalized: String = path.nfc().collect();
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains('\\')
        || normalized.bytes().any(|byte| byte == 0)
    {
        return Err(CryptoError::InvalidPath);
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty() || *part == "." || *part == ".." || part.chars().any(char::is_control)
    }) {
        return Err(CryptoError::InvalidPath);
    }
    Ok(parts.join("/"))
}

/// 用 vaultKey 派生索引密钥，再计算 `base64url(HMAC-SHA256(indexKey, "note:" + NFC(path)))`。
pub fn note_entity_id(
    vault_key: &[u8; KEY_BYTES],
    relative_path: &str,
) -> Result<String, CryptoError> {
    let path = normalize_note_path(relative_path)?;
    let index_key = derive_purpose_key(vault_key, "note-index")?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(index_key.as_ref())
        .map_err(|_| CryptoError::Derivation)?;
    mac.update(b"note:");
    mac.update(path.as_bytes());
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// 让测试和调用方安全清理临时秘密缓冲区。
pub fn clear_secret(buffer: &mut [u8]) {
    buffer.zeroize();
}

// ---------------------------------------------------------------------------
// 备份文件分块容器（v1，自描述头）
//
// 布局：magic(8) || plain_size(8 BE) || plain_sha256(32) || salt(32) ||
// nonce_prefix(16) || chunk*；每块 = XChaCha20-Poly1305(plain_chunk)，
// nonce = nonce_prefix || chunk_index(8 BE)，AAD = magic || salt || index。
// 头部自描述使恢复方不依赖任何带外元数据即可解密 manifest 或文件；写入侧
// 先写占位头、流式加密、最后 seek 回填明文大小与摘要。
// ---------------------------------------------------------------------------

use std::io::{Read, Seek, SeekFrom, Write};

pub const FILE_CONTAINER_MAGIC: &[u8; 8] = b"AISCBK01";
pub const FILE_CHUNK_SIZE: u32 = 1024 * 1024;
const FILE_SALT_BYTES: usize = 32;
const FILE_NONCE_PREFIX_BYTES: usize = 16;
pub const FILE_HEADER_BYTES: usize = 8 + 8 + 32 + FILE_SALT_BYTES + FILE_NONCE_PREFIX_BYTES;
const AEAD_TAG_BYTES: usize = 16;

/// 一次流式加密产生的结果元数据（随 manifest 一起保存，恢复时用于解密校验）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEncryptionMeta {
    pub algorithm: String,
    pub chunk_size: u32,
    pub salt: String,
    pub nonce_prefix: String,
    pub plain_size: u64,
    pub plain_sha256: String,
}

fn file_key(vault_key: &[u8; KEY_BYTES], salt: &[u8]) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    let base = derive_purpose_key(vault_key, "backup-file")?;
    let hkdf = Hkdf::<Sha256>::new(Some(salt), base.as_ref());
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    hkdf.expand(b"aishell.cloud-sync/v1/backup-file-chunk", key.as_mut())
        .map_err(|_| CryptoError::Derivation)?;
    Ok(key)
}

fn chunk_nonce(prefix: &[u8; FILE_NONCE_PREFIX_BYTES], index: u64) -> [u8; NONCE_BYTES] {
    let mut nonce = [0u8; NONCE_BYTES];
    nonce[..FILE_NONCE_PREFIX_BYTES].copy_from_slice(prefix);
    nonce[FILE_NONCE_PREFIX_BYTES..].copy_from_slice(&index.to_be_bytes());
    nonce
}

fn chunk_aad(salt: &[u8], index: u64) -> Vec<u8> {
    let mut aad = FILE_CONTAINER_MAGIC.to_vec();
    aad.extend_from_slice(salt);
    aad.extend_from_slice(&index.to_be_bytes());
    aad
}

/// 流式加密到 writer（需要 Seek 以回填头部明文摘要）；返回随 manifest 保存的元数据。
pub fn encrypt_file_stream<R: Read, W: Write + Seek>(
    vault_key: &[u8; KEY_BYTES],
    mut input: R,
    mut output: W,
) -> Result<FileEncryptionMeta, CryptoError> {
    let salt = random_bytes::<FILE_SALT_BYTES>()?;
    let nonce_prefix = random_bytes::<FILE_NONCE_PREFIX_BYTES>()?;
    let key = file_key(vault_key, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
    output
        .write_all(&[0u8; FILE_HEADER_BYTES])
        .map_err(|error| CryptoError::Io(format!("写入加密容器失败: {error}")))?;
    let mut plain_hasher = Sha256::new();
    let mut plain_size = 0u64;
    let mut index = 0u64;
    let mut buffer = vec![0u8; FILE_CHUNK_SIZE as usize];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| CryptoError::Io(format!("读取待备份文件失败: {error}")))?;
        if read == 0 {
            break;
        }
        plain_hasher.update(&buffer[..read]);
        plain_size += read as u64;
        let nonce = chunk_nonce(&nonce_prefix, index);
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce), chacha20poly1305::aead::Payload {
                msg: &buffer[..read],
                aad: &chunk_aad(&salt, index),
            })
            .map_err(|_| CryptoError::AuthenticationFailed)?;
        output
            .write_all(&ciphertext)
            .map_err(|error| CryptoError::Io(format!("写入加密容器失败: {error}")))?;
        buffer[..read].zeroize();
        index += 1;
    }
    let plain_sha256 = hex::encode(plain_hasher.finalize());
    let plain_hash_bytes = hex::decode(&plain_sha256).map_err(|_| CryptoError::InvalidSha256)?;
    output
        .seek(SeekFrom::Start(0))
        .and_then(|_| output.write_all(FILE_CONTAINER_MAGIC))
        .and_then(|_| output.write_all(&plain_size.to_be_bytes()))
        .and_then(|_| output.write_all(&plain_hash_bytes))
        .and_then(|_| output.write_all(&salt))
        .and_then(|_| output.write_all(&nonce_prefix))
        .map_err(|error| CryptoError::Io(format!("回填加密容器头失败: {error}")))?;
    Ok(FileEncryptionMeta {
        algorithm: "xchacha20-poly1305".to_string(),
        chunk_size: FILE_CHUNK_SIZE,
        salt: encode_base64(&salt),
        nonce_prefix: encode_base64(&nonce_prefix),
        plain_size,
        plain_sha256,
    })
}

/// 从自描述头读取元数据并流式解密；每块 AEAD 与最终明文 SHA-256 任一不符即拒绝。
pub fn decrypt_file_stream<R: Read, W: Write>(
    vault_key: &[u8; KEY_BYTES],
    mut input: R,
    mut output: W,
) -> Result<FileEncryptionMeta, CryptoError> {
    let mut header = vec![0u8; FILE_HEADER_BYTES];
    input
        .read_exact(&mut header)
        .map_err(|_| CryptoError::InvalidMetadata)?;
    if header[..8] != FILE_CONTAINER_MAGIC[..] {
        return Err(CryptoError::InvalidMetadata);
    }
    let mut size_bytes = [0u8; 8];
    size_bytes.copy_from_slice(&header[8..16]);
    let plain_size = u64::from_be_bytes(size_bytes);
    let plain_sha256 = hex::encode(&header[16..48]);
    let salt = &header[48..48 + FILE_SALT_BYTES];
    let nonce_prefix_raw = &header[48 + FILE_SALT_BYTES..];
    let mut nonce_prefix = [0u8; FILE_NONCE_PREFIX_BYTES];
    nonce_prefix.copy_from_slice(nonce_prefix_raw);
    let key = file_key(vault_key, salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
    let block = FILE_CHUNK_SIZE as usize + AEAD_TAG_BYTES;
    let mut buffer = vec![0u8; block];
    let mut plain_hasher = Sha256::new();
    let mut written_size = 0u64;
    let mut index = 0u64;
    loop {
        let mut filled = 0usize;
        loop {
            let read = input
                .read(&mut buffer[filled..])
                .map_err(|error| CryptoError::Io(format!("读取加密容器失败: {error}")))?;
            if read == 0 {
                break;
            }
            filled += read;
            if filled == block {
                break;
            }
        }
        if filled == 0 {
            break;
        }
        if filled <= AEAD_TAG_BYTES {
            return Err(CryptoError::InvalidMetadata);
        }
        let nonce = chunk_nonce(&nonce_prefix, index);
        let mut plaintext = Zeroizing::new(
            cipher
                .decrypt(XNonce::from_slice(&nonce), chacha20poly1305::aead::Payload {
                    msg: &buffer[..filled],
                    aad: &chunk_aad(salt, index),
                })
                .map_err(|_| CryptoError::AuthenticationFailed)?,
        );
        plain_hasher.update(&plaintext);
        written_size += plaintext.len() as u64;
        output
            .write_all(&plaintext)
            .map_err(|error| CryptoError::Io(format!("写入恢复文件失败: {error}")))?;
        plaintext.zeroize();
        index += 1;
    }
    if written_size != plain_size || hex::encode(plain_hasher.finalize()) != plain_sha256 {
        return Err(CryptoError::AuthenticationFailed);
    }
    Ok(FileEncryptionMeta {
        algorithm: "xchacha20-poly1305".to_string(),
        chunk_size: FILE_CHUNK_SIZE,
        salt: encode_base64(salt),
        nonce_prefix: encode_base64(nonce_prefix_raw),
        plain_size,
        plain_sha256,
    })
}

/// 备份显示名加密：云端只看到密文与随机 nonce，列表页解锁后本地还原。
pub fn encrypt_backup_name(
    vault_key: &[u8; KEY_BYTES],
    name: &str,
) -> Result<(String, String), CryptoError> {
    let key = derive_purpose_key(vault_key, "backup-display-name")?;
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), name.as_bytes())
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    Ok((encode_base64(&ciphertext), encode_base64(&nonce)))
}

/// 还原备份显示名；envelope 缺失或密文损坏时返回错误，由调用方降级为「需解锁」。
pub fn decrypt_backup_name(
    vault_key: &[u8; KEY_BYTES],
    ciphertext: &str,
    nonce: &str,
) -> Result<String, CryptoError> {
    let key = derive_purpose_key(vault_key, "backup-display-name")?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
    let ciphertext = strict_standard_base64_decode(ciphertext)?;
    let nonce = strict_standard_base64_decode(nonce)?;
    if nonce.len() != NONCE_BYTES {
        return Err(CryptoError::InvalidMetadata);
    }
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::InvalidMetadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_container_round_trips_across_chunk_boundaries_and_empty_file() {
        use std::io::Cursor;
        let key = [9u8; KEY_BYTES];
        for size in [0usize, 1, FILE_CHUNK_SIZE as usize - 1, FILE_CHUNK_SIZE as usize, FILE_CHUNK_SIZE as usize * 2 + 123] {
            let plain: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
            let mut writer = Cursor::new(Vec::new());
            let meta = encrypt_file_stream(&key, plain.as_slice(), &mut writer).unwrap();
            assert_eq!(meta.plain_size as usize, size);
            let ciphertext = writer.into_inner();
            assert_eq!(ciphertext.len(), FILE_HEADER_BYTES + size + chunk_count(size) * 16);
            let mut restored = Vec::new();
            let parsed = decrypt_file_stream(&key, ciphertext.as_slice(), &mut restored).unwrap();
            assert_eq!(parsed, meta);
            assert_eq!(restored, plain);
        }
    }

    fn chunk_count(size: usize) -> usize {
        size.div_ceil(FILE_CHUNK_SIZE as usize)
    }

    #[test]
    fn file_container_rejects_corruption_wrong_key_and_bad_magic() {
        use std::io::Cursor;
        let key = [9u8; KEY_BYTES];
        let plain = vec![42u8; FILE_CHUNK_SIZE as usize + 10];
        let mut writer = Cursor::new(Vec::new());
        encrypt_file_stream(&key, plain.as_slice(), &mut writer).unwrap();
        let ciphertext = writer.into_inner();

        let wrong_key = [8u8; KEY_BYTES];
        assert!(matches!(
            decrypt_file_stream(&wrong_key, ciphertext.as_slice(), Vec::new()),
            Err(CryptoError::AuthenticationFailed)
        ));

        let mut corrupted = ciphertext.clone();
        let last = corrupted.len() - 1;
        corrupted[last] ^= 0x01;
        assert!(matches!(
            decrypt_file_stream(&key, corrupted.as_slice(), Vec::new()),
            Err(CryptoError::AuthenticationFailed)
        ));

        let mut bad_magic = ciphertext.clone();
        bad_magic[0] ^= 0x01;
        assert!(matches!(
            decrypt_file_stream(&key, bad_magic.as_slice(), Vec::new()),
            Err(CryptoError::InvalidMetadata)
        ));
    }

    #[test]
    fn backup_name_round_trip_and_tamper_rejection() {
        let key = [11u8; KEY_BYTES];
        let (ciphertext, nonce) = encrypt_backup_name(&key, "项目资料 2026").unwrap();
        assert_eq!(decrypt_backup_name(&key, &ciphertext, &nonce).unwrap(), "项目资料 2026");
        assert!(decrypt_backup_name(&[12u8; KEY_BYTES], &ciphertext, &nonce).is_err());
        assert!(decrypt_backup_name(&key, &ciphertext, "bad-nonce").is_err());
    }

    #[test]
    fn envelope_round_trip_and_wrong_password_fails() {
        let vault_key = generate_vault_key().unwrap();
        let envelope = create_key_envelope("正确的密码", &vault_key).unwrap();
        let opened = open_key_envelope("正确的密码", &envelope).unwrap();
        assert_eq!(opened.as_ref(), vault_key.as_ref());
        assert!(matches!(
            open_key_envelope("错误的密码", &envelope),
            Err(CryptoError::AuthenticationFailed)
        ));
    }

    #[test]
    fn sync_item_binds_all_aad_fields_and_supports_empty_plaintext() {
        let key = [7u8; KEY_BYTES];
        let encrypted = encrypt_sync_item(&key, "user-a", "note", "opaque-id", 1, b"").unwrap();
        let plaintext =
            decrypt_sync_item(&key, "user-a", "note", "opaque-id", 1, &encrypted).unwrap();
        assert!(plaintext.is_empty());
        for (user, entity_type, entity_id, schema) in [
            ("user-b", "note", "opaque-id", 1),
            ("user-a", "credential_secret", "opaque-id", 1),
            ("user-a", "note", "other-id", 1),
            ("user-a", "note", "opaque-id", 2),
        ] {
            assert!(matches!(
                decrypt_sync_item(&key, user, entity_type, entity_id, schema, &encrypted),
                Err(CryptoError::AuthenticationFailed)
            ));
        }
    }

    #[test]
    fn ciphertext_tampering_is_rejected_by_hash_before_open() {
        let key = [9u8; KEY_BYTES];
        let mut encrypted = encrypt_sync_item(&key, "u", "note", "id", 1, b"payload").unwrap();
        let mut raw = strict_standard_base64_decode(&encrypted.ciphertext).unwrap();
        raw[0] ^= 1;
        encrypted.ciphertext = encode_base64(&raw);
        assert!(matches!(
            decrypt_sync_item(&key, "u", "note", "id", 1, &encrypted),
            Err(CryptoError::AuthenticationFailed)
        ));
    }

    #[test]
    fn base64_and_hash_are_strict() {
        assert!(decode_strict_base64("YQ==").is_ok());
        assert!(decode_strict_base64("YQ==\n").is_err());
        assert!(decode_strict_base64("YQ").is_err());
        assert!(validate_sha256_hex(&sha256_hex(b"x")).is_ok());
        assert!(validate_sha256_hex(&sha256_hex(b"x").to_uppercase()).is_err());
        assert!(validate_sha256_hex("00").is_err());
    }

    #[test]
    fn note_id_uses_nfc_and_rejects_escape_paths() {
        let key = [1u8; KEY_BYTES];
        assert_eq!(
            note_entity_id(&key, "目录/e\u{301}.md").unwrap(),
            note_entity_id(&key, "目录/é.md").unwrap()
        );
        assert!(note_entity_id(&key, "../secret.md").is_err());
        assert!(note_entity_id(&key, "/absolute.md").is_err());
        assert!(note_entity_id(&key, "a//b.md").is_err());
    }
}
