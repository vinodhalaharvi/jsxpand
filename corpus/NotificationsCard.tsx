import { useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export function NotificationsCard() {
  const [email, setEmail] = useState(true);
  const [push, setPush] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Choose what you hear about.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center gap-2">
          <Switch id="email" checked={email} onCheckedChange={setEmail} />
          <Label htmlFor="email">Email</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="push" checked={push} onCheckedChange={setPush} />
          <Label htmlFor="push">Push</Label>
        </div>
      </CardContent>
      <CardFooter>
        <Button className="w-full">Save</Button>
      </CardFooter>
    </Card>
  );
}
