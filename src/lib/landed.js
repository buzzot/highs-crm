/** Landed price/cost per unit: logistics is spread over all units by quantity. */
export function landed(order, items) {
  const qty = (items || []).reduce((s, i) => s + Number(i.quantity || 0), 0);
  const freight = Number(order.freight_total || 0);
  return {
    qty,
    freightPerUnit: qty ? freight / qty : 0,
    landedCostTotal: Number(order.cost_total || 0) + freight,
    landedSellTotal: Number(order.subtotal || 0) + freight,
    items: (items || []).map(i => ({
      ...i,
      landed_unit_cost: Number(i.unit_cost || 0) + (qty ? freight / qty : 0),
      landed_unit_price: Number(i.unit_price || 0) + (qty ? freight / qty : 0),
    })),
  };
}
