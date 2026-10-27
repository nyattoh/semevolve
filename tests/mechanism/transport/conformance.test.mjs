import { createMemoryTaskStore } from '@semevolve/core';
import { transportMutableCollections } from '@semevolve/transport-adapters';
import { conformance } from './conformance.mjs';
conformance('memory', () => createMemoryTaskStore({ mutableCollections: transportMutableCollections }));
