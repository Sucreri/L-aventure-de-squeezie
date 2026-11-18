/**
 * Catalogue (spec 5).
 *
 * What is shown comes from the server, already filtered by the viewer's
 * verified age. A product above their bracket is absent from the response —
 * the app is not hiding it, it never received it.
 */

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Loading, ErrorBanner, Divider }
  from '../src/components/ui';
import { api, type Product, type Store } from '../src/api';
import { useSession, usePublicSettings } from '../src/session';
import { spacing, euros, palette } from '../src/theme';

export default function Catalogue() {
  const router = useRouter();
  const session = useSession();
  const settings = usePublicSettings();

  const [stores, setStores] = useState<Store[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!session.token) return;
    api.stores(session.token)
      .then(result => {
        setStores(result.stores);
        const first = result.stores[0];
        if (first && !session.storeId) session.setStoreId(first.id);
      })
      .catch(e => setFailure(e.message));
  }, [session.token]);

  useEffect(() => {
    if (!session.token || !session.storeId) return;
    api.catalogue(session.token, session.storeId)
      .then(result => setProducts(result.products))
      .catch(e => setFailure(e.message));
  }, [session.token, session.storeId]);

  if (failure) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!products || !stores) return <Screen><Loading /></Screen>;

  const store = stores.find(s => s.id === session.storeId);
  const units = session.basketUnits();
  const maxUnits = settings?.expressMaxUnits ?? 6;

  return (
    <Screen>
      <Title>Catalogue</Title>
      {store ? <Small>Acheté pour vous chez {store.name}</Small> : null}

      <View style={{ height: spacing.lg }} />

      <Card>
        <Row left="Jauge de capacité" right={`${units.toFixed(1)} / ${maxUnits}`} strong />
        <Small>
          Un palettier transporte un volume limité. Au-delà de {maxUnits} unités,
          il faut passer par une livraison planifiée.
        </Small>
      </Card>

      {products.map(product => (
        <ProductRow
          key={product.product_id}
          product={product}
          quantity={session.basket.find(l => l.product.product_id === product.product_id)?.quantity ?? 0}
          healthWarning={settings?.healthWarning ?? null}
          onAdd={() => session.addToBasket(product)}
          onSet={q => session.setQuantity(product.product_id, q)}
        />
      ))}

      <Divider />

      <Button
        label={`Voir le panier (${session.basket.length})`}
        onPress={() => router.push('/panier')}
        disabled={session.basket.length === 0}
      />
    </Screen>
  );
}

function ProductRow({ product, quantity, healthWarning, onAdd, onSet }: {
  product: Product;
  quantity: number;
  healthWarning: string | null;
  onAdd: () => void;
  onSet: (quantity: number) => void;
}) {
  return (
    <Card>
      <Row left={product.name} right={euros(product.indicative_price_cents)} strong />
      <Small>{product.format}</Small>

      {product.contains_alcohol && product.alcohol_notice ? (
        <View style={{
          marginTop: spacing.sm, padding: spacing.sm,
          backgroundColor: palette.noticeBg, borderRadius: 6,
        }}>
          <Small muted={false}>{product.alcohol_notice}</Small>
          {healthWarning ? <Small>{healthWarning}</Small> : null}
        </View>
      ) : null}

      <View style={{ height: spacing.sm }} />
      <Small>Prix indicatif. Vous payez le prix exact du ticket de caisse.</Small>

      <View style={{ height: spacing.sm }} />

      {quantity === 0 ? (
        <Button label="Ajouter" variant="secondary" onPress={onAdd} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Button label="−" variant="secondary" onPress={() => onSet(quantity - 1)}
                    accessibilityHint={`Retirer un ${product.name}`} />
          </View>
          <Body style={{ minWidth: 32, textAlign: 'center' }}>{quantity}</Body>
          <View style={{ flex: 1 }}>
            <Button label="+" variant="secondary" onPress={() => onSet(quantity + 1)}
                    accessibilityHint={`Ajouter un ${product.name}`} />
          </View>
        </View>
      )}
    </Card>
  );
}
