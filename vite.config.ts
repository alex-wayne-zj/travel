import { defineConfig } from 'vite';
export default defineConfig({base:'/',server:{proxy:{'/api':process.env.TRAVEL_DEV_API||'http://127.0.0.1:8078','/map-assets':{target:process.env.TRAVEL_DEV_MAP_ORIGIN||'http://127.0.0.1:8078',changeOrigin:true},'/map-packs':{target:process.env.TRAVEL_DEV_MAP_ORIGIN||'http://127.0.0.1:8078',changeOrigin:true}}}});
