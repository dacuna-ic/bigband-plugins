import { useRender } from "@base-ui/react/use-render";
import { type VariantProps } from "class-variance-authority";
declare const badgeVariants: (props?: {
    variant?: "default" | "destructive" | "secondary" | "outline" | "ghost" | "link";
} & import("class-variance-authority/types").ClassProp) => string;
declare function Badge({ className, variant, render, ...props }: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>): null;
export { Badge, badgeVariants };
