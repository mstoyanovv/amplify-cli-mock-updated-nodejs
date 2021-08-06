import assert from 'assert';
import { generateApplyDefaultsToInputTemplate } from '@aws-amplify/graphql-model-transformer';
import { MappingTemplate } from '@aws-amplify/graphql-transformer-core';
import { DataSourceProvider, TransformerContextProvider, TransformerResolverProvider } from '@aws-amplify/graphql-transformer-interfaces';
import { DynamoDbDataSource } from '@aws-cdk/aws-appsync';
import { Table } from '@aws-cdk/aws-dynamodb';
import * as cdk from '@aws-cdk/core';
import { Kind, ObjectTypeDefinitionNode, TypeNode } from 'graphql';
import {
  and,
  block,
  bool,
  compoundExpression,
  Expression,
  forEach,
  ifElse,
  iff,
  list,
  methodCall,
  obj,
  print,
  printBlock,
  qref,
  raw,
  ref,
  RESOLVER_VERSION_ID,
  set,
  str,
} from 'graphql-mapping-template';
import {
  applyKeyExpressionForCompositeKey,
  attributeTypeFromScalar,
  getBaseType,
  graphqlName,
  ModelResourceIDs,
  ResourceConstants,
  toCamelCase,
} from 'graphql-transformer-common';
import { IndexDirectiveConfiguration, PrimaryKeyDirectiveConfiguration } from './types';
import { lookupResolverName } from './utils';

export function replaceDdbPrimaryKey(config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider): void {
  // Replace the table's primary key with the value from @primaryKey.
  const { field, object } = config;
  const table = getTable(ctx, object) as any;
  const cfnTable = table.table;
  const tableAttrDefs = table.attributeDefinitions;
  const tableKeySchema = table.keySchema;
  const keySchema = getDdbKeySchema(config);
  const attrDefs = attributeDefinitions(config, ctx);
  const existingAttrDefSet = new Set(tableAttrDefs.map((ad: any) => ad.attributeName));
  const primaryKeyPartitionKeyName = field.name.value ?? 'id';
  const primaryKeyPartitionKeyType = attrDefs.find(attr => attr.attributeName === primaryKeyPartitionKeyName)?.attributeType ?? 'S';

  // First, remove any attribute definitions in the current primary key.
  for (const existingKey of tableKeySchema) {
    if (existingAttrDefSet.has(existingKey.attributeName)) {
      table.attributeDefinitions = tableAttrDefs.filter((ad: any) => {
        return ad.attributeName !== existingKey.attributeName;
      });
      existingAttrDefSet.delete(existingKey.attributeName);
    }
  }

  // Next, replace the key schema and add any new attribute definitions back.
  table.keySchema = keySchema;
  table.tablePartitionKey = { name: primaryKeyPartitionKeyName, type: primaryKeyPartitionKeyType };

  for (const attr of attrDefs) {
    if (!existingAttrDefSet.has(attr.attributeName)) {
      table.attributeDefinitions.push(attr);
    }
  }

  // CDK does not support modifying all of these things, so keep them in sync.
  cfnTable.keySchema = table.keySchema;
  cfnTable.attributeDefinitions = table.attributeDefinitions;
}

export function updateResolvers(config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider): void {
  const getResolver = getResolverObject(config, ctx, 'get');
  const listResolver = getResolverObject(config, ctx, 'list');
  const createResolver = getResolverObject(config, ctx, 'create');
  const updateResolver = getResolverObject(config, ctx, 'update');
  const deleteResolver = getResolverObject(config, ctx, 'delete');
  // TODO(cjihrig): Sync queries need to be supported here as well.

  if (getResolver) {
    addIndexToResolverSlot(getResolver, [setPrimaryKeySnippet(config, false)]);
  }

  if (listResolver) {
    addIndexToResolverSlot(listResolver, [
      print(setQuerySnippet(config, ctx, true)),
      `$util.qr($ctx.stash.put("${ResourceConstants.SNIPPETS.ModelQueryExpression}", $${ResourceConstants.SNIPPETS.ModelQueryExpression}))`,
    ]);
  }

  if (createResolver) {
    addIndexToResolverSlot(createResolver, [
      mergeInputsAndDefaultsSnippet(),
      setPrimaryKeySnippet(config, true),
      ensureCompositeKeySnippet(config, false),
    ]);
  }

  if (updateResolver) {
    addIndexToResolverSlot(updateResolver, [
      mergeInputsAndDefaultsSnippet(),
      setPrimaryKeySnippet(config, true),
      ensureCompositeKeySnippet(config, false),
    ]);
  }

  if (deleteResolver) {
    addIndexToResolverSlot(deleteResolver, [mergeInputsAndDefaultsSnippet(), setPrimaryKeySnippet(config, true)]);
  }
}

function getTable(context: TransformerContextProvider, object: ObjectTypeDefinitionNode): Table {
  const ddbDataSource = context.dataSources.get(object) as DynamoDbDataSource;
  const tableName = ModelResourceIDs.ModelTableResourceID(object.name.value);
  const table = ddbDataSource.ds.stack.node.findChild(tableName) as Table;

  assert(table);
  return table;
}

function getDdbKeySchema(config: PrimaryKeyDirectiveConfiguration) {
  const schema = [{ attributeName: config.field.name.value, keyType: 'HASH' }];

  if (config.sortKey.length > 0) {
    schema.push({ attributeName: getSortKeyName(config), keyType: 'RANGE' });
  }

  return schema;
}

function attributeTypeFromType(type: TypeNode, ctx: TransformerContextProvider) {
  const baseTypeName = getBaseType(type);
  const ofType = ctx.output.getType(baseTypeName);
  if (ofType && ofType.kind === Kind.ENUM_TYPE_DEFINITION) {
    return 'S';
  }
  return attributeTypeFromScalar(type);
}

function attributeDefinitions(config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider) {
  const { field, sortKey, sortKeyFields } = config;
  const definitions = [{ attributeName: field.name.value, attributeType: attributeTypeFromType(field.type, ctx) }];

  if (sortKeyFields.length === 1) {
    definitions.push({
      attributeName: sortKeyFields[0],
      attributeType: attributeTypeFromType(sortKey[0].type, ctx),
    });
  } else if (sortKeyFields.length > 1) {
    definitions.push({
      attributeName: getSortKeyName(config),
      attributeType: 'S',
    });
  }

  return definitions;
}

function getSortKeyName(config: PrimaryKeyDirectiveConfiguration): string {
  return config.sortKeyFields.join(ModelResourceIDs.ModelCompositeKeySeparator());
}

function getResolverObject(config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider, op: string) {
  // TODO(cjihrig): Need to handle sync queries once they are supported.
  const resolverName = lookupResolverName(config, ctx, op);

  if (!resolverName) {
    return null;
  }

  const objectName = op === 'get' || op === 'list' ? ctx.output.getQueryTypeName() : ctx.output.getMutationTypeName();

  if (!objectName) {
    return null;
  }

  return ctx.resolvers.getResolver(objectName, resolverName) ?? null;
}

function setPrimaryKeySnippet(config: PrimaryKeyDirectiveConfiguration, isMutation: boolean): string {
  const cmds: Expression[] = [
    qref(
      methodCall(ref('ctx.stash.metadata.put'), str(ResourceConstants.SNIPPETS.ModelObjectKey), modelObjectKeySnippet(config, isMutation)),
    ),
  ];

  return printBlock('Set the primary key')(compoundExpression(cmds));
}

function modelObjectKeySnippet(config: PrimaryKeyDirectiveConfiguration, isMutation: boolean) {
  const { field, sortKeyFields } = config;
  const argsPrefix = isMutation ? 'mergedValues' : 'ctx.args';
  const modelObject = {
    [field.name.value]: ref(`util.dynamodb.toDynamoDB($${argsPrefix}.${field.name.value})`),
  };

  if (sortKeyFields.length > 1) {
    const compositeSortKey = getSortKeyName(config);
    const compositeSortKeyValue = sortKeyFields
      .map(keyField => {
        return `\${${argsPrefix}.${keyField}}`;
      })
      .join(ModelResourceIDs.ModelCompositeKeySeparator());

    modelObject[compositeSortKey] = ref(`util.dynamodb.toDynamoDB("${compositeSortKeyValue}")`);
  } else if (sortKeyFields.length === 1) {
    modelObject[sortKeyFields[0]] = ref(`util.dynamodb.toDynamoDB($${argsPrefix}.${sortKeyFields[0]})`);
  }

  return obj(modelObject);
}

function ensureCompositeKeySnippet(config: PrimaryKeyDirectiveConfiguration, conditionallySetSortKey: boolean): string {
  const { sortKeyFields } = config;

  if (sortKeyFields.length < 2) {
    return '';
  }

  const argsPrefix = 'mergedValues';
  const condensedSortKey = getSortKeyName(config);
  const dynamoDBFriendlySortKeyName = toCamelCase(sortKeyFields.map(f => graphqlName(f)));
  const condensedSortKeyValue = sortKeyFields
    .map(keyField => {
      return `\${${argsPrefix}.${keyField}}`;
    })
    .join(ModelResourceIDs.ModelCompositeKeySeparator());

  return print(
    compoundExpression([
      ifElse(
        raw(`$util.isNull($ctx.stash.metadata.${ResourceConstants.SNIPPETS.DynamoDBNameOverrideMap})`),
        qref(
          methodCall(
            ref('ctx.stash.metadata.put'),
            str(ResourceConstants.SNIPPETS.DynamoDBNameOverrideMap),
            obj({
              [condensedSortKey]: str(dynamoDBFriendlySortKeyName),
            }),
          ),
        ),
        qref(
          methodCall(
            ref(`ctx.stash.metadata.${ResourceConstants.SNIPPETS.DynamoDBNameOverrideMap}.put`),
            str(condensedSortKey),
            str(dynamoDBFriendlySortKeyName),
          ),
        ),
      ),
      conditionallySetSortKey
        ? iff(
            ref(ResourceConstants.SNIPPETS.HasSeenSomeKeyArg),
            qref(`$ctx.args.input.put("${condensedSortKey}","${condensedSortKeyValue}")`),
          )
        : qref(`$ctx.args.input.put("${condensedSortKey}","${condensedSortKeyValue}")`),
    ]),
  );
}

function setQuerySnippet(config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider, isListResolver: boolean) {
  const { field, sortKey, sortKeyFields } = config;
  const keyFields = [field, ...sortKey];
  const keyNames = [field.name.value, ...sortKeyFields];
  const keyTypes = keyFields.map(k => attributeTypeFromType(k.type, ctx));
  const expressions: Expression[] = [];

  if (keyNames.length === 1) {
    const sortDirectionValidation = iff(
      raw(`!$util.isNull($ctx.args.sortDirection)`),
      raw(`$util.error("sortDirection is not supported for List operations without a Sort key defined.", "InvalidArgumentsError")`),
    );

    expressions.push(sortDirectionValidation);
  } else if (isListResolver === true && keyNames.length >= 1) {
    // This check is only needed for List queries.
    const sortDirectionValidation = iff(
      and([raw(`$util.isNull($ctx.args.${keyNames[0]})`), raw(`!$util.isNull($ctx.args.sortDirection)`)]),
      raw(
        `$util.error("When providing argument 'sortDirection' you must also provide argument '${keyNames[0]}'.", "InvalidArgumentsError")`,
      ),
    );

    expressions.push(sortDirectionValidation);
  }

  expressions.push(
    set(ref(ResourceConstants.SNIPPETS.ModelQueryExpression), obj({})),
    applyKeyExpressionForCompositeKey(keyNames, keyTypes, ResourceConstants.SNIPPETS.ModelQueryExpression),
  );

  return block(`Set query expression for key`, expressions);
}

export function appendSecondaryIndex(config: IndexDirectiveConfiguration, ctx: TransformerContextProvider): void {
  const { name, object, primaryKeyField } = config;
  const table = getTable(ctx, object) as any;
  const keySchema = getDdbKeySchema(config);
  const attrDefs = attributeDefinitions(config, ctx);
  const primaryKeyPartitionKeyName = primaryKeyField?.name?.value ?? 'id';
  const partitionKeyName = keySchema[0]?.attributeName;
  const sortKeyName = keySchema?.[1]?.attributeName;
  const partitionKeyType = attrDefs.find(attr => attr.attributeName === partitionKeyName)?.attributeType ?? 'S';
  const sortKeyType = sortKeyName ? attrDefs.find(attr => attr.attributeName === sortKeyName)?.attributeType ?? 'S' : undefined;
  const defaultGSI = ctx.featureFlags.getBoolean('secondaryKeyAsGSI', false);

  if (!defaultGSI && primaryKeyPartitionKeyName === partitionKeyName) {
    // Create an LSI.
    table.addLocalSecondaryIndex({
      indexName: name,
      projectionType: 'ALL',
      sortKey: sortKeyName
        ? {
            name: sortKeyName,
            type: sortKeyType,
          }
        : undefined,
    });
  } else {
    // Create a GSI.
    table.addGlobalSecondaryIndex({
      indexName: name,
      projectionType: 'ALL',
      partitionKey: {
        name: partitionKeyName,
        type: partitionKeyType,
      },
      sortKey: sortKeyName
        ? {
            name: sortKeyName,
            type: sortKeyType,
          }
        : undefined,
      readCapacity: cdk.Fn.ref(ResourceConstants.PARAMETERS.DynamoDBModelTableReadIOPS),
      writeCapacity: cdk.Fn.ref(ResourceConstants.PARAMETERS.DynamoDBModelTableWriteIOPS),
    });

    // At the L2 level, the CDK does not handle the way Amplify sets GSI read and write capacity
    // very well. At the L1 level, the CDK does not create the correct IAM policy for accessing the
    // GSI. To get around these issues, keep the L1 and L2 GSI list in sync.
    const cfnTable = table.table;
    cfnTable.globalSecondaryIndexes = appendIndex(cfnTable.globalSecondaryIndexes, {
      indexName: name,
      keySchema,
      projection: { projectionType: 'ALL' },
      provisionedThroughput: cdk.Fn.conditionIf(ResourceConstants.CONDITIONS.ShouldUsePayPerRequestBilling, cdk.Fn.ref('AWS::NoValue'), {
        ReadCapacityUnits: cdk.Fn.ref(ResourceConstants.PARAMETERS.DynamoDBModelTableReadIOPS),
        WriteCapacityUnits: cdk.Fn.ref(ResourceConstants.PARAMETERS.DynamoDBModelTableWriteIOPS),
      }),
    });
  }
}

function appendIndex(list: any, newIndex: any): any[] {
  if (Array.isArray(list)) {
    list.push(newIndex);
    return list;
  }

  return [newIndex];
}

export function updateResolversForIndex(config: IndexDirectiveConfiguration, ctx: TransformerContextProvider): void {
  const { queryField } = config;
  const createResolver = getResolverObject(config, ctx, 'create');
  const updateResolver = getResolverObject(config, ctx, 'update');
  const deleteResolver = getResolverObject(config, ctx, 'delete');
  // TODO(cjihrig): Sync queries need to be supported here as well.

  // Ensure any composite sort key values and validate update operations to
  // protect the integrity of composite sort keys.
  if (createResolver) {
    const checks = [validateIndexArgumentSnippet(config, 'create'), ensureCompositeKeySnippet(config, true)];

    if (checks[0] || checks[1]) {
      addIndexToResolverSlot(createResolver, [mergeInputsAndDefaultsSnippet(), ...checks]);
    }
  }

  if (updateResolver) {
    const checks = [validateIndexArgumentSnippet(config, 'update'), ensureCompositeKeySnippet(config, true)];

    if (checks[0] || checks[1]) {
      addIndexToResolverSlot(updateResolver, [mergeInputsAndDefaultsSnippet(), ...checks]);
    }
  }

  if (deleteResolver) {
    const checks = [ensureCompositeKeySnippet(config, false)];

    if (checks[0]) {
      addIndexToResolverSlot(deleteResolver, [mergeInputsAndDefaultsSnippet(), ...checks]);
    }
  }

  if (queryField) {
    makeQueryResolver(config, ctx);
  }
}

function makeQueryResolver(config: IndexDirectiveConfiguration, ctx: TransformerContextProvider) {
  const { name, object, queryField } = config;
  const dataSource = ctx.api.host.getDataSource(`${object.name.value}Table`);
  const queryTypeName = ctx.output.getQueryTypeName() as string;
  const table = getTable(ctx, object);
  const requestVariable = 'QueryRequest';

  assert(dataSource);

  const resolver = ctx.resolvers.generateQueryResolver(
    queryTypeName,
    queryField,
    dataSource as DataSourceProvider,
    MappingTemplate.s3MappingTemplateFromString(
      print(
        compoundExpression([
          setQuerySnippet(config, ctx, false),
          set(ref('limit'), ref(`util.defaultIfNull($context.args.limit, ${ResourceConstants.DEFAULT_PAGE_LIMIT})`)),
          set(
            ref(requestVariable),
            obj({
              version: str(RESOLVER_VERSION_ID),
              operation: str('Query'),
              limit: ref('limit'),
              query: ref(ResourceConstants.SNIPPETS.ModelQueryExpression),
              index: str(name),
            }),
          ),
          ifElse(
            raw(`!$util.isNull($ctx.args.sortDirection)
                      && $ctx.args.sortDirection == "DESC"`),
            set(ref(`${requestVariable}.scanIndexForward`), bool(false)),
            set(ref(`${requestVariable}.scanIndexForward`), bool(true)),
          ),
          iff(ref('context.args.nextToken'), set(ref(`${requestVariable}.nextToken`), ref('context.args.nextToken')), true),
          iff(
            ref('context.args.filter'),
            set(ref(`${requestVariable}.filter`), ref('util.parseJson("$util.transform.toDynamoDBFilterExpression($ctx.args.filter)")')),
            true,
          ),
          raw(`$util.toJson($${requestVariable})`),
        ]),
      ),
      `${queryTypeName}.${queryField}.req.vtl`,
    ),
    MappingTemplate.s3MappingTemplateFromString(
      print(
        compoundExpression([
          iff(ref('ctx.error'), raw('$util.error($ctx.error.message, $ctx.error.type)')),
          raw('$util.toJson($ctx.result)'),
        ]),
      ),
      `${queryTypeName}.${queryField}.res.vtl`,
    ),
  );

  resolver.mapToStack(table.stack);
  ctx.resolvers.addResolver(object.name.value, queryField, resolver);
}

// When issuing an create/update mutation that creates/changes one part of a composite sort key,
// you must supply the entire key so that the underlying composite key can be resaved
// in a create/update operation. We only need to update for composite sort keys on secondary indexes.
// There is some tight coupling between setting 'hasSeenSomeKeyArg' in this method and calling ensureCompositeKeySnippet with conditionallySetSortKey = true
// That function expects this function to set 'hasSeenSomeKeyArg'.
function validateIndexArgumentSnippet(config: IndexDirectiveConfiguration, keyOperation: 'create' | 'update'): string {
  const { name, sortKeyFields } = config;

  if (sortKeyFields.length < 2) {
    return '';
  }

  return printBlock(`Validate ${keyOperation} mutation for @index '${name}'`)(
    compoundExpression([
      set(ref(ResourceConstants.SNIPPETS.HasSeenSomeKeyArg), bool(false)),
      set(ref('keyFieldNames'), list(sortKeyFields.map(f => str(f)))),
      forEach(ref('keyFieldName'), ref('keyFieldNames'), [
        iff(raw(`$ctx.args.input.containsKey("$keyFieldName")`), set(ref(ResourceConstants.SNIPPETS.HasSeenSomeKeyArg), bool(true)), true),
      ]),
      forEach(ref('keyFieldName'), ref('keyFieldNames'), [
        iff(
          raw(`$${ResourceConstants.SNIPPETS.HasSeenSomeKeyArg} && !$ctx.args.input.containsKey("$keyFieldName")`),
          raw(
            `$util.error("When ${keyOperation.replace(/.$/, 'ing')} any part of the composite sort key for @index '${name}',` +
              ` you must provide all fields for the key. Missing key: '$keyFieldName'.")`,
          ),
        ),
      ]),
    ]),
  );
}

function mergeInputsAndDefaultsSnippet() {
  return printBlock('Merge default values and inputs')(generateApplyDefaultsToInputTemplate('mergedValues'));
}

function addIndexToResolverSlot(resolver: TransformerResolverProvider, lines: string[]): void {
  const res = resolver as any;

  res.addToSlot(
    'postAuth',
    MappingTemplate.s3MappingTemplateFromString(
      lines.join('\n') + '\n{}',
      `${res.typeName}.${res.fieldName}.{slotName}.{slotIndex}.req.vtl`,
    ),
  );
}