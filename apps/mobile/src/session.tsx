/**
 * Session and basket state.
 *
 * Kept in memory on purpose for this stage: persisting a token needs
 * expo-secure-store on device, and writing it to localStorage on web would be
 * a worse default than asking someone to sign in again.
 */

import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import { api, type Product, type PublicSettings } from './api';

export interface BasketLine {
  readonly product: Product;
  readonly quantity: number;
}

interface SessionValue {
  token: string | null;
  userId: string | null;
  settings: PublicSettings | null;
  basket: BasketLine[];
  addressId: string | null;
  storeId: string | null;

  signIn(token: string, userId: string): void;
  signOut(): void;
  setSettings(settings: PublicSettings): void;
  setAddressId(id: string | null): void;
  setStoreId(id: string | null): void;

  addToBasket(product: Product, quantity?: number): void;
  setQuantity(productId: string, quantity: number): void;
  clearBasket(): void;

  /** Capacity units in the basket, against the Express ceiling (spec 6.5). */
  basketUnits(): number;
  basketItemsCents(): number;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<PublicSettings | null>(null);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);

  const signIn = useCallback((nextToken: string, nextUserId: string) => {
    setToken(nextToken);
    setUserId(nextUserId);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUserId(null);
    setBasket([]);
    setAddressId(null);
  }, []);

  const addToBasket = useCallback((product: Product, quantity = 1) => {
    setBasket(current => {
      const existing = current.find(l => l.product.product_id === product.product_id);
      if (!existing) return [...current, { product, quantity }];
      return current.map(l =>
        l.product.product_id === product.product_id
          ? { ...l, quantity: l.quantity + quantity }
          : l);
    });
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setBasket(current => quantity <= 0
      ? current.filter(l => l.product.product_id !== productId)
      : current.map(l => l.product.product_id === productId ? { ...l, quantity } : l));
  }, []);

  const value = useMemo<SessionValue>(() => ({
    token, userId, settings, basket, addressId, storeId,
    signIn, signOut,
    setSettings: setSettingsState,
    setAddressId, setStoreId,
    addToBasket, setQuantity,
    clearBasket: () => setBasket([]),
    basketUnits: () => basket.reduce(
      (total, l) => total + Number(l.product.capacity_units) * l.quantity, 0),
    basketItemsCents: () => basket.reduce(
      (total, l) => total + l.product.indicative_price_cents * l.quantity, 0),
  }), [token, userId, settings, basket, addressId, storeId,
       signIn, signOut, addToBasket, setQuantity]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession doit être utilisé dans un SessionProvider.');
  return value;
}

/** Loads the public settings once, at startup. */
export function usePublicSettings(): PublicSettings | null {
  const { settings, setSettings } = useSession();

  React.useEffect(() => {
    if (settings) return;
    let cancelled = false;
    api.publicSettings()
      .then(loaded => { if (!cancelled) setSettings(loaded); })
      .catch(() => { /* l'écran concerné affichera l'erreur */ });
    return () => { cancelled = true; };
  }, [settings, setSettings]);

  return settings;
}
