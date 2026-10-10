import { writeFileSync } from 'fs';
import { parse } from 'jsonc-parser';
import {
  CONFIG_PATH,
  DEFAULT_HEX_ID,
  DEFAULT_KV_NAMESPACE_NAMES,
  DEFAULT_SECRET_STORE_NAME,
  DEFAULT_UUID,
  VECTORIZE_DIMENSIONS,
  type D1Database,
  type KVNamespace,
  type SecretStore,
  type WranglerConfig,
} from './types';
import { parseJsonArray, runWrangler } from './cli';
import { readConfig, writeConfigValue } from './patches';

export function getD1Id(database: D1Database): string | undefined {
  return database.uuid ?? database.database_id ?? database.id;
}

export function listD1Databases(): D1Database[] {
  return parseJsonArray<D1Database>(runWrangler(['d1', 'list', '--json']), 'wrangler d1 list --json');
}

export function ensureD1Database(databaseName: string): string {
  let database = listD1Databases().find((candidate) => candidate.name === databaseName);
  if (!database) {
    console.log(`Creating D1 database: ${databaseName}`);
    runWrangler(['d1', 'create', databaseName]);
    database = listD1Databases().find((candidate) => candidate.name === databaseName);
  }

  const databaseId = database ? getD1Id(database) : undefined;
  if (!databaseId) {
    throw new Error(`Unable to discover D1 database ID for ${databaseName}.`);
  }
  return databaseId;
}

export function listKVNamespaces(): KVNamespace[] {
  return parseJsonArray<KVNamespace>(runWrangler(['kv', 'namespace', 'list']), 'wrangler kv namespace list');
}

export function getKVNamespaceName(config: WranglerConfig, binding: string): string {
  return DEFAULT_KV_NAMESPACE_NAMES[binding] ?? `${config.name ?? 'durable-dav'}-${binding.toLowerCase()}`;
}

export function ensureKVNamespace(config: WranglerConfig, binding: string): string {
  const namespaceName = getKVNamespaceName(config, binding);
  const candidateNames = new Set([namespaceName, `${config.name ?? 'durable-dav'}-${binding}`, binding]);
  let namespace = listKVNamespaces().find((candidate) => {
    const candidateName = candidate.title ?? candidate.name;
    return candidate.id && candidateName && candidateNames.has(candidateName);
  });
  if (!namespace) {
    console.log(`Creating KV namespace: ${namespaceName}`);
    runWrangler(['kv', 'namespace', 'create', namespaceName]);
    namespace = listKVNamespaces().find((candidate) => candidate.id && (candidate.title ?? candidate.name) === namespaceName);
  }

  if (!namespace?.id) {
    throw new Error(`Unable to discover KV namespace ID for ${namespaceName}.`);
  }
  return namespace.id;
}

export function getRequiredKvBindings(): string[] {
  return Object.keys(DEFAULT_KV_NAMESPACE_NAMES);
}

export function ensureRequiredKvBindings(content: string, config: WranglerConfig): string {
  const existing = new Set((config.kv_namespaces ?? []).map((namespace) => namespace.binding).filter(Boolean));
  const missing = getRequiredKvBindings().filter((binding) => !existing.has(binding));
  if (missing.length === 0) {
    return content;
  }

  const next = [...(config.kv_namespaces ?? [])];
  for (const binding of missing) {
    console.log(`Adding missing KV namespace binding: ${binding}`);
    next.push({ binding, id: DEFAULT_HEX_ID });
  }
  return writeConfigValue(content, ['kv_namespaces'], next);
}

export function parseSecretStoresTable(output: string): SecretStore[] {
  const stores: SecretStore[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes('│')) {
      continue;
    }

    const cells = line
      .split('│')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 2 || cells[0] === 'Name' || cells[0].includes('─')) {
      continue;
    }

    const [name, id] = cells;
    if (/^[a-f0-9]{32}$/i.test(id)) {
      stores.push({ name, id });
    }
  }
  return stores;
}

export function listSecretStores(): SecretStore[] {
  const output = runWrangler(['secrets-store', 'store', 'list', '--remote']);
  try {
    return parseJsonArray<SecretStore>(output, 'wrangler secrets-store store list --remote');
  } catch {
    return parseSecretStoresTable(output);
  }
}

export function ensureSecretStore(): string {
  const existing = listSecretStores().find((candidate) => candidate.name === DEFAULT_SECRET_STORE_NAME);
  if (existing) {
    return existing.id;
  }

  // Deliberately not `?? stores[0]`. An account holding several stores and none
  // named `default` would otherwise have had its Worker bound to whichever
  // happened to sort first — so the replication key would land in an unrelated
  // store, and the store_id in the config would not be reproducible from the
  // config alone. Creating a named store is the only predictable answer.
  console.log(`Creating Secrets Store: ${DEFAULT_SECRET_STORE_NAME}`);
  const output = runWrangler(['secrets-store', 'store', 'create', DEFAULT_SECRET_STORE_NAME, '--remote']);
  const createdStoreId = output.match(/ID:\s*([a-f0-9]{32})/i)?.[1];
  if (createdStoreId) {
    return createdStoreId;
  }

  const created = listSecretStores().find((candidate) => candidate.name === DEFAULT_SECRET_STORE_NAME);
  if (!created?.id) {
    throw new Error(`Unable to discover Secrets Store ID for ${DEFAULT_SECRET_STORE_NAME}.`);
  }
  return created.id;
}

export function ensureQueue(queueName: string): void {
  try {
    runWrangler(['queues', 'info', queueName]);
    console.log(`Queue ${queueName} already exists.`);
  } catch {
    console.log(`Creating queue: ${queueName}`);
    runWrangler(['queues', 'create', queueName]);
  }
}

export function ensureVectorizeIndex(indexName: string, dimensions: number): void {
  try {
    runWrangler(['vectorize', 'info', indexName]);
    console.log(`Vectorize index ${indexName} already exists.`);
  } catch {
    console.log(`Creating Vectorize index: ${indexName} with ${dimensions} dimensions`);
    runWrangler(['vectorize', 'create', indexName, `--dimensions=${dimensions}`, '--metric=cosine']);
  }
}

export function provisionWranglerResources(): void {
  let { content, config } = readConfig();

  // KV namespaces — inject required bindings missing from custom configs
  // (e.g. WRANGLER_JSONC without kv_namespaces) so CD auto-creates them.
  content = ensureRequiredKvBindings(content, config);
  config = parse(content) as WranglerConfig;

  // D1 databases — patch placeholder UUIDs with real IDs
  for (const [index, database] of config.d1_databases?.entries() ?? []) {
    if (database.database_id !== DEFAULT_UUID) {
      continue;
    }
    if (!database.database_name) {
      throw new Error(`D1 database binding ${database.binding ?? index} has a placeholder database_id but no database_name.`);
    }

    const databaseId = ensureD1Database(database.database_name);
    console.log(`Using D1 database ${database.database_name}: ${databaseId}`);
    content = writeConfigValue(content, ['d1_databases', index, 'database_id'], databaseId);
  }

  // KV namespaces — patch placeholder hex IDs with real IDs
  config = parse(content) as WranglerConfig;
  for (const [index, namespace] of config.kv_namespaces?.entries() ?? []) {
    if (namespace.id !== DEFAULT_HEX_ID) {
      continue;
    }
    if (!namespace.binding) {
      throw new Error(`KV namespace at index ${index} has a placeholder id but no binding.`);
    }

    const namespaceId = ensureKVNamespace(config, namespace.binding);
    console.log(`Using KV namespace ${getKVNamespaceName(config, namespace.binding)}: ${namespaceId}`);
    content = writeConfigValue(content, ['kv_namespaces', index, 'id'], namespaceId);
  }

  // Secrets Store — patch placeholder hex IDs with real store ID
  config = parse(content) as WranglerConfig;
  const secretStoreIndexes = (config.secrets_store_secrets ?? [])
    .map((secret, index) => ({ secret, index }))
    .filter(({ secret }) => secret.store_id === DEFAULT_HEX_ID);
  if (secretStoreIndexes.length > 0) {
    const storeId = ensureSecretStore();
    console.log(`Using Secrets Store: ${storeId}`);
    for (const { index } of secretStoreIndexes) {
      content = writeConfigValue(content, ['secrets_store_secrets', index, 'store_id'], storeId);
    }
  }

  writeFileSync(CONFIG_PATH, content.endsWith('\n') ? content : `${content}\n`);

  // Queues — name-based, no config patching needed
  config = parse(content) as WranglerConfig;
  const queueNames = new Set<string>();
  for (const producer of config.queues?.producers ?? []) {
    queueNames.add(producer.queue);
  }
  for (const consumer of config.queues?.consumers ?? []) {
    queueNames.add(consumer.queue);
  }
  for (const queueName of queueNames) {
    ensureQueue(queueName);
  }

  // Vectorize indexes — name-based, no config patching needed
  for (const binding of config.vectorize ?? []) {
    ensureVectorizeIndex(binding.index_name, VECTORIZE_DIMENSIONS);
  }
}
