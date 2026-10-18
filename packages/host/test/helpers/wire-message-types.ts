import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Resolve only declared wire union members, including imported aliases and inherited discriminators. */
export function declaredWireMessageTypes(unionName: string, sources: ReadonlyMap<string, string>): Set<string> {
  const declarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const [path, text] of sources) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
      const name = statement.name.text;
      assert.ok(!declarations.has(name), `ambiguous wire declaration ${name}`);
      declarations.set(name, statement);
    }
  }

  function literals(node: ts.TypeNode): string[] {
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(literals);
    assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal),
      'wire discriminator must contain only string literals');
    return [node.literal.text];
  }

  function fromNode(node: ts.TypeNode, seen: ReadonlySet<string>): string[] {
    if (ts.isParenthesizedTypeNode(node)) return fromNode(node.type, seen);
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(member => fromNode(member, seen));
    assert.ok(ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName),
      'wire union member must reference a declared type');
    return fromName(node.typeName.text, seen);
  }

  function fromName(name: string, seen: ReadonlySet<string>): string[] {
    assert.ok(!seen.has(name), `cyclic wire declaration ${name}`);
    const declaration = declarations.get(name);
    assert.ok(declaration, `could not locate wire declaration ${name} in selected shared sources`);
    const next = new Set([...seen, name]);
    if (ts.isTypeAliasDeclaration(declaration)) return fromNode(declaration.type, next);
    const discriminator = declaration.members.find(member => ts.isPropertySignature(member)
      && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === 'type');
    if (discriminator && ts.isPropertySignature(discriminator) && discriminator.type) {
      return literals(discriminator.type);
    }
    const parents = (declaration.heritageClauses ?? [])
      .filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap(clause => clause.types);
    assert.ok(parents.length > 0, `wire declaration ${name} has no type discriminator`);
    return parents.flatMap(parent => {
      assert.ok(ts.isIdentifier(parent.expression), `unsupported wire parent of ${name}`);
      return fromName(parent.expression.text, next);
    });
  }

  return new Set(fromName(unionName, new Set()));
}

export function readWireMessageTypes(unionName: string, paths: readonly string[]): Set<string> {
  return declaredWireMessageTypes(unionName, new Map(paths.map(path => [path, readFileSync(path, 'utf8')])));
}

/** Type-guard branches are the dedicated attention channel's dispatch/consume boundary. */
export function guardedWireMessageTypes(consumer: string, sources: ReadonlyMap<string, string>): Set<string> {
  const guards = new Map<string, string>();
  for (const [path, text] of sources) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.type
        || !ts.isTypePredicateNode(statement.type) || !statement.type.type) continue;
      const target = statement.type.type;
      if (ts.isTypeReferenceNode(target) && ts.isIdentifier(target.typeName)) {
        guards.set(statement.name.text, target.typeName.text);
      }
    }
  }
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const condition = ts.isPrefixUnaryExpression(node.expression)
        && node.expression.operator === ts.SyntaxKind.ExclamationToken ? node.expression.operand : node.expression;
      if (ts.isCallExpression(condition) && ts.isIdentifier(condition.expression)) {
        const target = guards.get(condition.expression.text);
        if (target) for (const type of declaredWireMessageTypes(target, sources)) result.add(type);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('consumer.ts', consumer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return result;
}
