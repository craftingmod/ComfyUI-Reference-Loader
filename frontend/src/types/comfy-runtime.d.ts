declare module "*/scripts/api.js" {
  export const api: import("@comfyorg/comfyui-frontend-types").ComfyApi
}

declare module "*/scripts/app.js" {
  export const app: import("@comfyorg/comfyui-frontend-types").ComfyApp
}

declare module "*/scripts/changeTracker.js" {
  export class ChangeTracker {
    undoRedo(event: KeyboardEvent): Promise<true | undefined>
  }
}
