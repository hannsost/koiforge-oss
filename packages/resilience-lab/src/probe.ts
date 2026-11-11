import { FileDatasetRegistry } from '@koiforge/data-registry';

import type { ResilienceSnapshot } from './types.js';

function asString(value: string | number | boolean | null | undefined): string {
  return value == null ? '' : String(value);
}

const statusPriority = ['delayed', 'watchlist', 'review', 'pending', 'approved', 'shipped', 'active'];

function supplierGroupKey(row: Record<string, string | number | boolean | null>): string {
  const supplierId = asString(row.supplierId);
  if (supplierId.length > 0) return supplierId;
  return `name:${normalizeName(asString(row.name))}`;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenizeName(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !['gmbh', 'ltd', 'group', 'inc', 'corp'].includes(token));
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  let mismatches = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    mismatches += 1;
    if (mismatches > 1) return false;

    if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return true;
}

function tokenMatches(queryToken: string, candidateToken: string): boolean {
  if (candidateToken === queryToken) return true;
  if (candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken)) return true;
  if (queryToken.length >= 4 && candidateToken.length >= 4 && editDistanceAtMostOne(queryToken, candidateToken)) return true;
  return false;
}

function nameSimilarity(query: string, candidate: string): number {
  const queryTokens = tokenizeName(query);
  const candidateTokens = tokenizeName(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  let matched = 0;
  for (const queryToken of queryTokens) {
    if (candidateTokens.some((candidateToken) => tokenMatches(queryToken, candidateToken))) {
      matched += 1;
    }
  }

  return matched / queryTokens.length;
}

function resolveSupplier(
  row: Record<string, string | number | boolean | null>,
  suppliers: Array<Record<string, string | number | boolean | null>>,
) {
  const supplierId = asString(row.supplierId);
  if (supplierId) {
    const exact = suppliers.find((entry) => asString(entry.supplierId) === supplierId);
    if (exact) return exact;
  }

  const supplierName = asString(row.supplierName);
  if (!supplierName) return undefined;
  const scored = suppliers
    .map((entry) => ({ entry, score: nameSimilarity(supplierName, asString(entry.name)) }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best) return undefined;
  if (best.score < 0.5) return undefined;
  if (second && best.score - second.score < 0.15) return undefined;

  return best.entry;
}

function pickCanonicalStatus(statuses: string[]): string {
  const unique = [...new Set(statuses.filter((entry) => entry.length > 0))];
  if (unique.length === 0) return '';
  return [...unique].sort((left, right) => statusPriority.indexOf(left) - statusPriority.indexOf(right))[0] ?? unique[0]!;
}

function aggregateOrders(rows: Array<Record<string, string | number | boolean | null>>) {
  const groups = new Map<string, Array<Record<string, string | number | boolean | null>>>();

  for (const row of rows) {
    const key = asString(row.poNumber);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const statuses = group.map((entry) => asString(entry.status));
    const supplierName = group.map((entry) => asString(entry.supplierName)).find((entry) => entry.length > 0) ?? '';
    const supplierId = group.map((entry) => asString(entry.supplierId)).find((entry) => entry.length > 0) ?? '';
    const values = group.map((entry) => (typeof entry.value === 'number' ? entry.value : Number(asString(entry.value)))).filter((entry) => !Number.isNaN(entry));

    const aggregated: Record<string, string | number | boolean | null> = {
      ...first,
      supplierId,
      supplierName,
      status: pickCanonicalStatus(statuses),
      statusConflict: [...new Set(statuses.filter((entry) => entry.length > 0))].length > 1,
      sourceRowCount: group.length,
      value: values.length > 0 ? Math.max(...values) : (first.value ?? null),
    };

    return aggregated;
  });
}

function aggregateSuppliers(rows: Array<Record<string, string | number | boolean | null>>) {
  const groups = new Map<string, Array<Record<string, string | number | boolean | null>>>();

  for (const row of rows) {
    const key = supplierGroupKey(row);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const statuses = group.map((entry) => asString(entry.status));
    const riskScores = group.map((entry) => (typeof entry.riskScore === 'number' ? entry.riskScore : Number(asString(entry.riskScore)))).filter((entry) => !Number.isNaN(entry));
    const supplierId = group.map((entry) => asString(entry.supplierId)).find((entry) => entry.length > 0) ?? '';

    const aggregated: Record<string, string | number | boolean | null> = {
      ...first,
      supplierId,
      status: pickCanonicalStatus(statuses),
      statusConflict: [...new Set(statuses.filter((entry) => entry.length > 0))].length > 1,
      sourceRowCount: group.length,
      riskScore: riskScores.length > 0 ? Math.max(...riskScores) : (first.riskScore ?? null),
    };

    return aggregated;
  });
}

function buildSupplierObjects(
  suppliers: Array<Record<string, string | number | boolean | null>>,
  orders: Array<Record<string, string | number | boolean | null>>,
) {
  return aggregateSuppliers(suppliers).map((row) => {
    const supplierId = asString(row.supplierId);
    const relatedOrders = orders.filter((order) => {
      if (asString(order.supplierId) === supplierId) return true;
      return normalizeName(asString(order.supplierName)) === normalizeName(asString(row.name));
    });
    return {
      id: supplierId || `missing-${asString(row.name)}`,
      title: asString(row.name),
      subtitle: asString(row.country ?? row.countryCode),
      attributes: {
        supplierId: row.supplierId ?? null,
        riskScore: row.riskScore ?? null,
        status: row.status ?? null,
        statusConflict: row.statusConflict ?? null,
        sourceRowCount: row.sourceRowCount ?? 1,
      },
      relationCounts: { orders: relatedOrders.length },
    };
  });
}

function buildOrderObjects(
  orders: Array<Record<string, string | number | boolean | null>>,
  suppliers: Array<Record<string, string | number | boolean | null>>,
) {
  return aggregateOrders(orders).map((row) => {
    const supplierId = asString(row.supplierId);
    const supplier = resolveSupplier(row, suppliers);
    return {
      id: asString(row.poNumber),
      title: asString(row.poNumber),
      subtitle: supplier ? asString(supplier.name) : asString(row.supplierName) || supplierId,
      attributes: {
        supplierId,
        supplierName: row.supplierName ?? null,
        status: row.status ?? null,
        statusConflict: row.statusConflict ?? null,
        sourceRowCount: row.sourceRowCount ?? 1,
        value: row.value ?? null,
        createdAt: row.createdAt ?? null,
      },
      relationCounts: { supplier: supplier ? 1 : 0 },
    };
  });
}

function extractPoNumber(payload: string | number | boolean | null | undefined): string {
  const text = asString(payload);
  const match = text.match(/PO-\d+/i);
  return match ? match[0].toUpperCase() : '';
}

function shipmentStage(eventType: string): number {
  const order = ['created', 'departed', 'customs-hold', 'delay-alert', 'delivered'];
  const index = order.indexOf(eventType);
  return index === -1 ? order.length : index;
}

function analyzeShipments(
  shipments: Array<Record<string, string | number | boolean | null>>,
  orderObjects: Array<{ id: string }>,
) {
  const knownOrderIds = new Set(orderObjects.map((entry) => entry.id));
  const orphanCount = shipments.filter((row) => {
    const poNumber = extractPoNumber(row.payload);
    return poNumber.length > 0 && !knownOrderIds.has(poNumber);
  }).length;

  const groups = new Map<string, Array<Record<string, string | number | boolean | null>>>();
  for (const row of shipments) {
    const shipmentId = asString(row.shipmentId);
    const current = groups.get(shipmentId) ?? [];
    current.push(row);
    groups.set(shipmentId, current);
  }

  let outOfOrderCount = 0;
  for (const group of groups.values()) {
    let highestSeen = -1;
    for (const row of [...group].sort((left, right) => asString(left.message_timestamp).localeCompare(asString(right.message_timestamp)))) {
      const stage = shipmentStage(asString(row.eventType));
      if (stage < highestSeen) {
        outOfOrderCount += 1;
      }
      highestSeen = Math.max(highestSeen, stage);
    }
  }

  return { orphanCount, outOfOrderCount };
}

export async function collectSnapshot(datasetRegistry: FileDatasetRegistry): Promise<ResilienceSnapshot> {
  const [supplierPreview, orderPreview, shipmentPreview] = await Promise.all([
    datasetRegistry.previewRows('procurement_supplier_master', 200),
    datasetRegistry.previewRows('procurement_purchase_orders', 200),
    datasetRegistry.previewRows('procurement_shipment_events', 200),
  ]);

  const supplierObjects = buildSupplierObjects(supplierPreview.rows, orderPreview.rows);
  const orderObjects = buildOrderObjects(orderPreview.rows, supplierPreview.rows);
  const shipmentAnalysis = analyzeShipments(shipmentPreview.rows, orderObjects);

  const supplierIds = supplierPreview.rows.map((row) => asString(row.supplierId)).filter(Boolean);
  const duplicateCount = new Set(supplierIds).size < supplierIds.length ? supplierIds.length - new Set(supplierIds).size : 0;
  const supplierConflictCount = supplierObjects.filter((entry) => entry.attributes.statusConflict === true).length;
  const orderConflictCount = orderObjects.filter((entry) => entry.attributes.statusConflict === true).length;
  const highRisk = supplierPreview.rows.filter((row) => typeof row.riskScore === 'number' && row.riskScore >= 35).length;
  const unknownOrders = orderObjects.filter((entry) => entry.relationCounts.supplier === 0).length;
  const delayedOrders = orderPreview.rows.filter((row) => asString(row.status) === 'delayed').length;

  let detailProbeSuccess = false;
  const firstSupplier = supplierObjects[0];
  if (firstSupplier) {
    detailProbeSuccess = true;
  }

  return {
    metrics: {
      supplier_preview_rows: supplierPreview.rowCount,
      supplier_object_count: supplierObjects.length,
      order_object_count: orderObjects.length,
      shipment_preview_rows: shipmentPreview.rowCount,
      supplier_missing_id_count: supplierPreview.rows.filter((row) => asString(row.supplierId).length === 0).length,
      supplier_duplicate_id_count: duplicateCount,
      supplier_status_conflict_count: supplierConflictCount,
      order_status_conflict_count: orderConflictCount,
      unknown_supplier_orders_count: unknownOrders,
      orphan_shipment_event_count: shipmentAnalysis.orphanCount,
      out_of_order_shipment_count: shipmentAnalysis.outOfOrderCount,
      high_risk_supplier_count: highRisk,
      delayed_order_count: delayedOrders,
      detail_probe_success: detailProbeSuccess,
    },
    samples: {
      supplierPreview: supplierPreview.rows.slice(0, 5),
      supplierObjects: supplierObjects.slice(0, 5),
      orderObjects: orderObjects.slice(0, 5),
    },
  };
}
