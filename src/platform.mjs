// Picks the API client for an account: 'facebook' (Page) or 'instagram' (the default, also for older rows).
import * as instagram from './meta.mjs';
import * as facebook from './facebook.mjs';

export const PLATFORMS = ['instagram', 'facebook'];
export const apiFor = (type) => (type === 'facebook' ? facebook : instagram);
