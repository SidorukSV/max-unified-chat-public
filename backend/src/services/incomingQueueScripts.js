// Fixed scripts use only KEYS/ARGV (never message content as executable code).
// Return JSON strings so the small RESP client does not need array responses.
const validateKeyTypes = `
local expected = {'list', 'hash', 'zset', 'list'}
for i, key in ipairs(KEYS) do
    local actual = redis.call('TYPE', key).ok
    if actual ~= 'none' and actual ~= expected[i] then
        return redis.error_reply('incoming_queue_key_type_invalid')
    end
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;

export const claimIncomingScript = validateKeyTypes + `
-- Recovery and claim are atomic relative to all other Redis clients.
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 1000)
for i = #expired, 1, -1 do
    local receipt = expired[i]
    local raw = redis.call('HGET', KEYS[2], receipt)
    if raw then redis.call('LPUSH', KEYS[1], raw) end
    redis.call('HDEL', KEYS[2], receipt)
    redis.call('ZREM', KEYS[3], receipt)
end

local result = {}
local limit = tonumber(ARGV[1])
local expires = now + tonumber(ARGV[2])
-- Bound poison processing as well as useful messages to avoid blocking Redis.
for i = 1, limit do
    local raw = redis.call('LINDEX', KEYS[1], 0)
    if not raw then break end
    local valid, envelope = pcall(cjson.decode, raw)
    if not valid or type(envelope) ~= 'table' or type(envelope.id) ~= 'string'
        or type(envelope.update) ~= 'table' then
        redis.call('RPUSH', KEYS[4], raw)
    else
        local receipt = ARGV[3] .. ':' .. i
        redis.call('HSET', KEYS[2], receipt, raw)
        redis.call('ZADD', KEYS[3], expires, receipt)
        table.insert(result, {raw = raw, receipt = receipt, lease_expires_at = expires})
    end
    redis.call('LPOP', KEYS[1])
end
return cjson.encode({claims = result})
`;

export const acknowledgeIncomingScript = validateKeyTypes + `
local acknowledged = 0
for _, receipt in ipairs(ARGV) do
    local expires = redis.call('ZSCORE', KEYS[3], receipt)
    if expires and tonumber(expires) > now then
        acknowledged = acknowledged + redis.call('HDEL', KEYS[2], receipt)
        redis.call('ZREM', KEYS[3], receipt)
    end
end
return acknowledged
`;
