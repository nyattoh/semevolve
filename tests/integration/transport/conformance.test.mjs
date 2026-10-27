import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileTaskStore } from '@semevolve/core';
import { transportMutableCollections } from '@semevolve/transport-adapters';
import { conformance } from '../../mechanism/transport/conformance.mjs';
conformance('durable', async () => openFileTaskStore(await mkdtemp(join(tmpdir(), 'semevolve-transport-')), { mutableCollections: transportMutableCollections }));
