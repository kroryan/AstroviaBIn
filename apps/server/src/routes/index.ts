import type { Hono } from 'hono';
import imageRoutes from './images';
import plateSolvingRoutes from './plate-solving';
import equipmentRoutes from './equipment';
import equipmentGroupRoutes from './equipment-groups';
import systemRoutes from './system';
import skyMapRoutes from './sky-map';
import locationRoutes from './locations';
import targetRoutes from './targets';
import catalogRoutes from './catalog';
import userTargetRoutes from './user-targets';
import fitsRoutes from './fits';
import libraryRoutes from './library';
import hotpantsRoutes from './hotpants';
import spectroscopyRoutes from './spectroscopy';
import galleryCatalogRoutes from './gallery-catalogs';
import userRoutes from './users';
import type { WsManager } from '../services/ws-manager';

export function registerRoutes(app: Hono, wsManager?: WsManager) {
  app.route('/api/images', imageRoutes);
  app.route('/api/plate-solving', plateSolvingRoutes(wsManager));
  app.route('/api/equipment', equipmentRoutes);
  app.route('/api/equipment-groups', equipmentGroupRoutes);
  app.route('/api/sky-map', skyMapRoutes);
  app.route('/api/locations', locationRoutes);
  app.route('/api/targets', targetRoutes);
  app.route('/api/catalog', catalogRoutes);
  app.route('/api/user-targets', userTargetRoutes);
  app.route('/api/fits', fitsRoutes);
  app.route('/api/fits', hotpantsRoutes);
  app.route('/api/fits', spectroscopyRoutes);
  app.route('/api/library', libraryRoutes);
  app.route('/api/gallery-catalogs', galleryCatalogRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api', systemRoutes(wsManager));
}
