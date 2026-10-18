// A Windows service named BamDude that never finishes stopping: the installer acceptance's way to prove that
// Setup refuses to touch the installed payload while the service is not proven stopped (spec stage B R13, S4/S4b).
// OnStop never returns, so the SCM shows STOP_PENDING for as long as the process lives; the harness kills the
// process and deletes the service in its cleanup. Built on the runner with the .NET Framework's csc — never on a
// developer's machine, never shipped.
using System.ServiceProcess;
using System.Threading;

public class StubbornService : ServiceBase
{
    public StubbornService()
    {
        ServiceName = "BamDude";
        CanStop = true;
    }

    protected override void OnStop()
    {
        Thread.Sleep(Timeout.Infinite);
    }

    public static void Main()
    {
        ServiceBase.Run(new StubbornService());
    }
}
