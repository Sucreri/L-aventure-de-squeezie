import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider } from '../src/components/ui';
import { useSession, usePublicSettings } from '../src/session';
import { spacing, euros } from '../src/theme';

export default function Panier() {
  const router = useRouter();
  const session = useSession();
  const settings = usePublicSettings();

  const units = session.basketUnits();
  const maxUnits = settings?.expressMaxUnits ?? 6;
  const overCapacity = units > maxUnits;

  if (session.basket.length === 0) {
    return (
      <Screen>
        <Title>Panier</Title>
        <Body muted>Votre panier est vide.</Body>
        <Button label="Voir le catalogue" onPress={() => router.replace('/catalogue')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Panier</Title>

      {session.basket.map(line => (
        <Card key={line.product.product_id}>
          <Row
            left={`${line.quantity} × ${line.product.name}`}
            right={euros(line.product.indicative_price_cents * line.quantity)}
            strong
          />
          <Small>{line.product.format}</Small>

          {line.product.contains_alcohol && line.product.alcohol_notice ? (
            <Small muted={false}>{line.product.alcohol_notice}</Small>
          ) : null}

          <View style={{ height: spacing.sm }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Button label="−" variant="secondary"
                      onPress={() => session.setQuantity(line.product.product_id, line.quantity - 1)}
                      accessibilityHint={`Retirer un ${line.product.name}`} />
            </View>
            <Body style={{ minWidth: 32, textAlign: 'center' }}>{line.quantity}</Body>
            <View style={{ flex: 1 }}>
              <Button label="+" variant="secondary"
                      onPress={() => session.setQuantity(line.product.product_id, line.quantity + 1)}
                      accessibilityHint={`Ajouter un ${line.product.name}`} />
            </View>
          </View>
        </Card>
      ))}

      <Divider />

      <Card tone={overCapacity ? 'danger' : 'default'}>
        <Row left="Jauge de capacité" right={`${units.toFixed(1)} / ${maxUnits}`} strong />
        {overCapacity ? (
          <Small muted={false}>
            Ce panier dépasse ce qu'un palettier peut porter en une fois.
            Retirez un article ou choisissez une livraison planifiée.
          </Small>
        ) : null}
      </Card>

      <Card>
        <Row left="Articles (prix indicatif)" right={euros(session.basketItemsCents())} />
        <Small>
          Les frais de livraison dépendent de votre étage et du nombre de
          palettes. Le total exact s'affiche à l'écran suivant, avant tout
          paiement.
        </Small>
      </Card>

      <Button
        label="Continuer"
        onPress={() => router.push('/recapitulatif')}
        disabled={overCapacity}
      />
    </Screen>
  );
}
