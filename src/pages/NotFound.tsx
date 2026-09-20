import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        <Logo size={40} withWordmark={false} />
        <h1 className="mt-6 font-display text-6xl font-bold tracking-tight">404</h1>
        <p className="mt-2 text-lg text-muted-foreground">
          This frame didn’t develop.
        </p>
        <Button asChild className="mt-8">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    </motion.div>
  );
}
