import test from 'node:test';
import assert from 'node:assert';
import { diffOpenApiSpecs } from '../src/workers/specDiff.js';

// --- Fixture helpers (fully offline) ---

function specWithResponse(responseSchema, { method = 'get', path = '/v1/charges', components } = {}) {
  return {
    openapi: '3.0.0',
    info: { title: 'Deep Fixture', version: '1.0.0' },
    ...(components ? { components } : {}),
    paths: {
      [path]: {
        [method]: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: responseSchema } }
            }
          }
        }
      }
    }
  };
}

function specWithRequest(requestSchema) {
  return {
    openapi: '3.0.0',
    info: { title: 'Deep Fixture', version: '1.0.0' },
    paths: {
      '/v1/charges': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: requestSchema } }
          },
          responses: { '200': { description: 'OK' } }
        }
      }
    }
  };
}

test('76. Spec Diff (deep): nested response property removal is breaking with dotted location', () => {
  const oldSpec = specWithResponse({
    type: 'object',
    properties: {
      id: { type: 'string' },
      customer: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' }
        }
      }
    }
  });
  const newSpec = specWithResponse({
    type: 'object',
    properties: {
      id: { type: 'string' },
      customer: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      }
    }
  });

  const changes = diffOpenApiSpecs(oldSpec, newSpec);
  const removed = changes.find(c => c.kind === 'removed_response_property');
  assert.ok(removed, 'Removed nested customer.email must be detected');
  assert.strictEqual(removed.breaking, true);
  assert.strictEqual(removed.location, 'GET /v1/charges response property customer.email');
  assert.ok(removed.summary.includes('customer.email'));
});

test('77. Spec Diff (deep): nested request property type change is breaking', () => {
  const oldSpec = specWithRequest({
    type: 'object',
    properties: {
      amount: { type: 'integer' },
      metadata: {
        type: 'object',
        properties: { order_id: { type: 'string' } }
      }
    }
  });
  const newSpec = specWithRequest({
    type: 'object',
    properties: {
      amount: { type: 'integer' },
      metadata: {
        type: 'object',
        properties: { order_id: { type: 'integer' } }
      }
    }
  });

  const changes = diffOpenApiSpecs(oldSpec, newSpec);
  const typeChange = changes.find(c => c.kind === 'request_property_type_changed');
  assert.ok(typeChange, 'Nested metadata.order_id type change must be detected');
  assert.strictEqual(typeChange.breaking, true);
  assert.strictEqual(typeChange.location, 'POST /v1/charges request property metadata.order_id');
  assert.ok(typeChange.summary.includes('string') && typeChange.summary.includes('integer'));
});

test('78. Spec Diff (deep): $ref property targets are followed for type changes and nested removals', () => {
  const componentsOld = {
    schemas: {
      Money: { type: 'string' },
      Customer: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' }
        }
      }
    }
  };
  const componentsNew = {
    schemas: {
      Money: { type: 'integer' },
      Customer: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      }
    }
  };
  const body = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      total: { $ref: '#/components/schemas/Money' },
      customer: { $ref: '#/components/schemas/Customer' }
    }
  };
  const oldSpec = specWithResponse(body, { components: componentsOld });
  const newSpec = specWithResponse(body, { components: componentsNew });

  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const refType = changes.find(c => c.kind === 'response_property_type_changed'
    && c.location === 'GET /v1/charges response property total');
  assert.ok(refType, "Type change inside the $ref'd Money schema must be detected");
  assert.strictEqual(refType.breaking, true);

  const refNested = changes.find(c => c.kind === 'removed_response_property'
    && c.location === 'GET /v1/charges response property customer.email');
  assert.ok(refNested, "Removal inside the $ref'd Customer schema must be detected at customer.email");
  assert.strictEqual(refNested.breaking, true);
});

test('79. Spec Diff (deep): removed enum values are breaking on properties and parameters', () => {
  const oldSpec = specWithResponse({
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'past_due', 'canceled'] }
    }
  });
  oldSpec.paths['/v1/charges'].get.parameters = [
    { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'closed'] } }
  ];
  const newSpec = specWithResponse({
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'canceled'] }
    }
  });
  newSpec.paths['/v1/charges'].get.parameters = [
    { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['open'] } }
  ];

  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const propEnum = changes.find(c => c.kind === 'removed_enum_value'
    && c.location === 'GET /v1/charges response property status');
  assert.ok(propEnum, "Removed 'past_due' enum value on status must be detected");
  assert.strictEqual(propEnum.breaking, true);
  assert.ok(propEnum.summary.includes('past_due'));

  const paramEnum = changes.find(c => c.kind === 'removed_enum_value'
    && c.location === 'GET /v1/charges param state:query');
  assert.ok(paramEnum, "Removed 'closed' enum value on the state parameter must be detected");
  assert.strictEqual(paramEnum.breaking, true);
  assert.ok(paramEnum.summary.includes('closed'));
});

test('80. Spec Diff (deep): circular self-referencing schemas terminate', () => {
  const circularSpec = {
    openapi: '3.0.0',
    info: { title: 'Circular Fixture', version: '1.0.0' },
    components: {
      schemas: {
        Category: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parent: { $ref: '#/components/schemas/Category' }
          }
        }
      }
    },
    paths: {
      '/v1/categories': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Category' } } }
            }
          }
        }
      }
    }
  };

  // Identical circular specs: no changes, and the diff returns at all.
  assert.deepStrictEqual(diffOpenApiSpecs(circularSpec, circularSpec), []);

  // A change inside the self-referencing component is still caught, once per
  // reachable path, without descending the parent chain forever.
  const changedSpec = JSON.parse(JSON.stringify(circularSpec));
  changedSpec.components.schemas.Category.properties.name = { type: 'integer' };
  const changes = diffOpenApiSpecs(circularSpec, changedSpec);
  const nameChange = changes.find(c => c.kind === 'response_property_type_changed'
    && c.location === 'GET /v1/categories response property name');
  assert.ok(nameChange, 'Type change inside the circular component must be detected');
  assert.strictEqual(nameChange.breaking, true);
});

test('81. Spec Diff (deep): an unchanged deep spec yields no changes', () => {
  const deepSpec = {
    openapi: '3.0.0',
    info: { title: 'Deep Fixture', version: '1.0.0' },
    components: {
      schemas: {
        Address: {
          type: 'object',
          properties: {
            line1: { type: 'string' },
            zip: { type: 'string' }
          },
          required: ['line1']
        }
      }
    },
    paths: {
      '/v1/charges': {
        get: {
          parameters: [
            { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'closed'] } }
          ],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string', enum: ['active', 'canceled'] },
                      customer: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          address: { $ref: '#/components/schemas/Address' }
                        }
                      },
                      line_items: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            sku: { type: 'string' },
                            qty: { type: 'integer' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  const clone = JSON.parse(JSON.stringify(deepSpec));
  assert.deepStrictEqual(diffOpenApiSpecs(deepSpec, clone), []);
});

test('82. Spec Diff (deep): array item properties are diffed; nested additions are non-breaking', () => {
  const oldSpec = specWithResponse({
    type: 'object',
    properties: {
      customer: {
        type: 'object',
        properties: { name: { type: 'string' } }
      },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            qty: { type: 'integer' }
          }
        }
      }
    }
  });
  const newSpec = specWithResponse({
    type: 'object',
    properties: {
      customer: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          loyalty_tier: { type: 'string' }
        }
      },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string' }
          }
        }
      }
    }
  });

  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const removedItemProp = changes.find(c => c.kind === 'removed_response_property');
  assert.ok(removedItemProp, 'Removed qty inside array items must be detected');
  assert.strictEqual(removedItemProp.breaking, true);
  assert.strictEqual(removedItemProp.location, 'GET /v1/charges response property line_items[].qty');

  const addedNested = changes.find(c => c.kind === 'added_response_property');
  assert.ok(addedNested, 'Added nested customer.loyalty_tier must be reported');
  assert.strictEqual(addedNested.breaking, false);
  assert.strictEqual(addedNested.location, 'GET /v1/charges response property customer.loyalty_tier');
});
