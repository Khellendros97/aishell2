/**
 * 数据库连接的共享展示/表单常量 —— 从 sidebar/servers.ts 迁出，供「服务器设置-数据库连接」
 * 弹窗与「AI 申请数据库连接」审批对话框（ai-db-approval.ts）共用，保证两处命令清单同源。
 * 契约：只读命令组与后端 store.rs DbKind::default_read_commands 严格一致（AI 可直接执行）；
 * 写命令组为常用写操作（勾选后保存进白名单，AI 执行前 guard 分类转人工审批）。
 */
import type { DbKind } from '../../types';

export const DB_KIND_LABEL: Record<DbKind, string> = {
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  redis: 'Redis',
  postgres: 'PostgreSQL',
};

/** 各类型默认端口：新建连接按类型预填，切换类型时若端口仍为旧默认则联动更新 */
export const DB_DEFAULT_PORTS: Record<DbKind, number> = {
  mysql: 3306,
  clickhouse: 9000,
  redis: 6379,
  postgres: 5432,
};

/** 各类型 AI 可用命令清单（表单勾选区用）：只读组与后端 store.rs DbKind::default_read_commands 严格一致；
 *  写组为常用写操作（勾选后保存进白名单，AI 执行前 guard 分类转人工审批）。 */
export const DB_COMMAND_GROUPS: Record<DbKind, { title: string; write: boolean; commands: string[] }[]> = {
  mysql: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'] },
  ],
  clickhouse: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: ['INSERT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'OPTIMIZE', 'RENAME'] },
  ],
  postgres: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'VACUUM', 'ANALYZE'] },
  ],
  redis: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: [
      'GET', 'MGET', 'KEYS', 'SCAN', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'DBSIZE',
      'INFO', 'PING', 'STRLEN', 'LLEN', 'SCARD', 'ZCARD', 'HLEN', 'HGET',
      'HGETALL', 'HKEYS', 'HVALS', 'SMEMBERS', 'LRANGE', 'ZRANGE', 'SISMEMBER',
      'HEXISTS', 'SRANDMEMBER', 'RANDOMKEY', 'ZSCORE', 'HSTRLEN', 'GETRANGE',
    ] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: [
      'SET', 'MSET', 'SETEX', 'DEL', 'EXPIRE', 'PERSIST', 'HSET', 'HDEL',
      'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'SADD', 'SREM', 'ZADD', 'ZREM',
      'RENAME', 'FLUSHDB', 'FLUSHALL',
    ] },
  ],
};

/** 各类型默认只读命令集（取命令清单的只读组） */
export const DB_DEFAULT_COMMANDS: Record<DbKind, string[]> = {
  mysql: DB_COMMAND_GROUPS.mysql[0].commands,
  clickhouse: DB_COMMAND_GROUPS.clickhouse[0].commands,
  redis: DB_COMMAND_GROUPS.redis[0].commands,
  postgres: DB_COMMAND_GROUPS.postgres[0].commands,
};
