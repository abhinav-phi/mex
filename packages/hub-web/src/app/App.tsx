import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HubApiError, isSetupCapabilityUnavailable, type HubApi } from "../api/client";
import { HubApiProvider, useCapabilities, useHubApi, useSession } from "../api/context";
import { StatePanel } from "../components/ui";
import { Button } from "../components/primitives/button";
import styles from "../styles/app.module.css";
import { DesktopRequired, HubLayout } from "./HubLayout";

const HomePage = lazy(async () => ({ default: (await import("../pages/HomePage")).HomePage }));
const SearchPage = lazy(async () => ({ default: (await import("../pages/SearchPage")).SearchPage }));
const CodePage = lazy(async () => ({ default: (await import("../pages/SearchPage")).CodePage }));
const KnowledgePage = lazy(async () => ({ default: (await import("../pages/ContextPage")).ContextPage }));
const KnowledgeDetailPage = lazy(async () => ({ default: (await import("../pages/KnowledgePage")).KnowledgeDetailPage }));
const SymbolPage = lazy(async () => ({ default: (await import("../pages/SymbolPage")).SymbolPage }));
const RoadmapPage = lazy(async () => ({ default: (await import("../pages/CapabilityPage")).RoadmapPage }));
const NotFoundPage = lazy(async () => ({ default: (await import("../pages/CapabilityPage")).NotFoundPage }));
const ActivityPage = lazy(async () => ({ default: (await import("../pages/ActivityPage")).ActivityPage }));
const MembersPage = lazy(async () => ({ default: (await import("../pages/MembersPage")).MembersPage }));
const WorkstreamsPage = lazy(async () => ({ default: (await import("../pages/WorkstreamsPage")).WorkstreamsPage }));
const SpecsPage = lazy(async () => ({ default: (await import("../pages/SpecsPage")).SpecsPage }));
const InboxPage = lazy(async () => ({ default: (await import("../pages/InboxPage")).InboxPage }));
const RelayPage = lazy(async () => ({ default: (await import("../pages/RelayPage")).RelayPage }));
const JobsPage = lazy(async () => ({ default: (await import("../pages/JobsPage")).JobsPage }));
const HealthPage = lazy(async () => ({ default: (await import("../pages/HealthPage")).HealthPage }));
const SettingsPage = lazy(async () => ({ default: (await import("../pages/SettingsPage")).SettingsPage }));
const SetupLayout = lazy(async () => ({ default: (await import("../pages/SetupPage")).SetupLayout }));

function SessionBoundary() {
  const session = useSession();
  const capabilities = useCapabilities();
  const api = useHubApi();
  const queryClient = useQueryClient();
  const setupStatus = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.getSetupStatus!(),
    retry: false,
    enabled: session.isSuccess && typeof api.getSetupStatus === "function",
  });
  const setupReady = setupStatus.isSuccess && setupStatus.data.ready;
  const graphAvailable = capabilities.data?.graph.read.availability === "available";

  useEffect(() => {
    if (!setupReady || graphAvailable) return;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
      void queryClient.invalidateQueries({ queryKey: ["capabilities"] });
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    };
    refresh();
    const poll = window.setInterval(refresh, 400);
    return () => window.clearInterval(poll);
  }, [setupReady, graphAvailable, queryClient]);

  if (session.isPending) {
    return <div className={styles.fullPageState}><StatePanel state="loading" title="Opening Project Hub" detail="Verifying this process-local session." /></div>;
  }

  if (session.isError) {
    const expired = session.error instanceof HubApiError && session.error.problem.code === "UNAUTHORIZED";
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="unavailable"
          title={expired ? "This Hub session has expired" : "A Hub session is required"}
          detail="Close this tab and run `mex hub` again. A fresh one-use link will create a new local session."
        />
      </div>
    );
  }

  if (
    typeof api.getSetupStatus === "function"
    && setupStatus.isPending
    && setupStatus.fetchStatus === "fetching"
  ) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="loading"
          title="Checking MEX setup"
          detail="Inspecting whether this checkout still needs the setup wizard."
        />
      </div>
    );
  }

  if (setupStatus.isSuccess && !setupStatus.data.ready) {
    return (
      <Suspense fallback={<div className={styles.fullPageState}><StatePanel state="loading" title="Opening setup" detail="Loading the MEX setup wizard." /></div>}>
        <SetupLayout session={session.data} />
      </Suspense>
    );
  }

  if (setupReady) {
    if (capabilities.isError) {
      return (
        <div className={styles.fullPageState}>
          <StatePanel
            state="error"
            title="Project capabilities could not be loaded"
            detail="The Hub could not safely verify which local workbenches are available. Try the check again before continuing."
            action={(
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => void capabilities.refetch()}
              >
                Try again
              </Button>
            )}
          />
        </div>
      );
    }
    if (!graphAvailable || !capabilities.data) {
      return (
        <div className={styles.fullPageState}>
          <StatePanel
            state="loading"
            title="Opening the Project Hub"
            detail="Setup finished. Switching this session to the Project Hub."
          />
        </div>
      );
    }
    return <HubLayout capabilities={capabilities.data} session={session.data} />;
  }

  if (capabilities.isPending) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="loading"
          title="Loading project capabilities"
          detail="Checking which local workbenches are available for this repository."
        />
      </div>
    );
  }

  if (capabilities.isError) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="error"
          title="Project capabilities could not be loaded"
          detail="The Hub could not safely verify which local workbenches are available. Try the check again before continuing."
          action={(
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void capabilities.refetch()}
            >
              Try again
            </Button>
          )}
        />
      </div>
    );
  }

  if (setupStatus.isError && !isSetupCapabilityUnavailable(setupStatus.error)) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="error"
          title="Setup status could not be loaded"
          detail="The Hub could not inspect this checkout. Try the check again before continuing."
          action={(
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void setupStatus.refetch()}
            >
              Try again
            </Button>
          )}
        />
      </div>
    );
  }

  return <HubLayout capabilities={capabilities.data} session={session.data} />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SessionBoundary />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="knowledge/:id" element={<KnowledgeDetailPage />} />
        <Route path="code" element={<CodePage />} />
        <Route path="code/symbols/:id" element={<SymbolPage />} />
        <Route path="workstreams" element={<WorkstreamsPage />} />
        <Route path="specs" element={<SpecsPage />} />
        <Route path="specs/:id" element={<SpecsPage />} />
        <Route path="playbooks" element={<RoadmapPage page="playbooks" />} />
        <Route path="catch-up" element={<RoadmapPage page="catch-up" />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="relays" element={<RelayPage />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="setup" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function HubApplication({ api, startupError }: { api: HubApi; startupError?: Error | null }) {
  return (
    <HubApiProvider api={api}>
      <div className={styles.desktopOnly}>
        {startupError ? (
          <div className={styles.fullPageState}>
            <StatePanel state="error" title="The one-use Hub link was not accepted" detail={startupError.message} />
          </div>
        ) : <AppRoutes />}
      </div>
      <div className={styles.compactOnly}><DesktopRequired /></div>
    </HubApiProvider>
  );
}

export function BrowserHubApplication(props: { api: HubApi; startupError?: Error | null }) {
  return <BrowserRouter><HubApplication {...props} /></BrowserRouter>;
}
